import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { confirmedPaymentMethod } from "./payment-confirmation.mjs";

const REGION = process.env.AWS_REGION || "us-east-1";
const CHAT_ID = "main";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const agentCore = new BedrockAgentCoreClient({ region: REGION });
const conversationsTable = process.env.CONVERSATIONS_TABLE;
const runtimeArn = process.env.AGENT_RUNTIME_ARN;
const allowedOrigin = process.env.ALLOWED_ORIGIN;

function responseHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-cache, no-transform",
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}

function startResponseStream(stream, statusCode, contentType) {
  const metadata = JSON.stringify({
    statusCode,
    headers: responseHeaders(contentType),
  });
  stream.write(`${metadata}${"\0".repeat(8)}`);
}

function sendEvent(stream, event) {
  stream.write(`data: ${JSON.stringify(event)}\n\n`);
}

function getUserId(event) {
  const claims =
    event.requestContext?.authorizer?.claims ??
    event.requestContext?.authorizer?.jwt?.claims;
  return typeof claims?.sub === "string" && claims.sub.length > 0
    ? claims.sub
    : null;
}

function parseBody(event) {
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "{}";
  return JSON.parse(rawBody);
}

function createMessage(userId, role, content, intentId = null) {
  const createdAt = new Date().toISOString();
  return {
    user_id: userId,
    message_id: `${createdAt}#${randomUUID()}`,
    chat_id: CHAT_ID,
    role,
    content,
    ...(typeof intentId === "string" && intentId ? { intent_id: intentId } : {}),
    created_at: createdAt,
  };
}

async function loadHistory(userId) {
  const messages = [];
  let lastKey;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: conversationsTable,
        KeyConditionExpression: "user_id = :user_id",
        ExpressionAttributeValues: { ":user_id": userId },
        ScanIndexForward: true,
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }),
    );
    messages.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return messages;
}

async function saveMessage(userId, role, content, intentId = null) {
  const item = createMessage(userId, role, content, intentId);
  await ddb.send(
    new PutCommand({
      TableName: conversationsTable,
      Item: item,
    }),
  );
  return item;
}

async function invokeAgent(userId, message, history, confirmedMethod) {
  const payload = {
    user_id: userId,
    chat_id: CHAT_ID,
    message,
    history: history.map(({ role, content, intent_id }) => ({
      role,
      content,
      ...(typeof intent_id === "string" && intent_id ? { intent_id } : {}),
    })),
    confirmed_method: confirmedMethod,
  };
  const result = await agentCore.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: runtimeArn,
      runtimeSessionId: `chatpay-${userId}-${randomUUID()}`,
      contentType: "application/json",
      accept: "application/json",
      payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
  const body = await result.response.transformToString();
  const decoded = JSON.parse(body);
  if (typeof decoded.response !== "string") {
    throw new Error("Agent runtime returned an invalid response.");
  }
  return {
    response: decoded.response,
    intentId: typeof decoded.intent_id === "string" ? decoded.intent_id : null,
  };
}

async function handleHistory(event, stream, userId) {
  const messages = await loadHistory(userId);
  startResponseStream(stream, 200, "application/json");
  stream.write(JSON.stringify({
    messages: messages
      .filter(({ role, content }) => ["user", "assistant"].includes(role) && content)
      .map(({ role, content }) => ({ role, content })),
  }));
}

async function handleChat(event, stream, userId) {
  let body;
  try {
    body = parseBody(event);
  } catch {
    startResponseStream(stream, 400, "text/event-stream; charset=utf-8");
    sendEvent(stream, { error: "A mensagem enviada não é um JSON válido." });
    return;
  }

  if (typeof body.message !== "string" || !body.message.trim() || body.message.length > 10000) {
    startResponseStream(stream, 400, "text/event-stream; charset=utf-8");
    sendEvent(stream, { error: "Envie uma mensagem com até 10.000 caracteres." });
    return;
  }

  const message = body.message.trim();
  let history;
  let savedUserMessage;
  try {
    [history, savedUserMessage] = await Promise.all([
      loadHistory(userId),
      saveMessage(userId, "user", message),
    ]);
  } catch (error) {
    console.error("Could not load or save conversation history", error);
    startResponseStream(stream, 500, "text/event-stream; charset=utf-8");
    sendEvent(stream, {
      error: "Não foi possível carregar a conversa. Tente novamente.",
    });
    return;
  }

  startResponseStream(stream, 200, "text/event-stream; charset=utf-8");
  sendEvent(stream, { status: "processing" });
  const heartbeat = setInterval(() => {
    sendEvent(stream, { status: "processing" });
  }, 15000);
  try {
    const { response: answer, intentId } = await invokeAgent(
      userId,
      message,
      history.filter(({ message_id }) => message_id !== savedUserMessage.message_id),
      confirmedPaymentMethod(message),
    );
    await saveMessage(userId, "assistant", answer, intentId);
    sendEvent(stream, { response: answer, done: true });
  } catch (error) {
    console.error("Chat request failed", error);
    sendEvent(stream, {
      response: "Não foi possível responder agora. Tente novamente em instantes.",
      error: "Não foi possível responder agora. Tente novamente em instantes.",
      done: true,
    });
  } finally {
    clearInterval(heartbeat);
  }
}

export const handler = awslambda.streamifyResponse(async (event, stream) => {
  const userId = getUserId(event);
  if (!userId) {
    startResponseStream(stream, 401, "application/json");
    stream.write(JSON.stringify({ message: "Usuário não autenticado." }));
    stream.end();
    return;
  }

  try {
    if (event.httpMethod === "GET" && event.resource === "/conversations") {
      await handleHistory(event, stream, userId);
    } else if (event.httpMethod === "POST" && event.resource === "/chat") {
      await handleChat(event, stream, userId);
    } else {
      startResponseStream(stream, 404, "application/json");
      stream.write(JSON.stringify({ message: "Rota não encontrada." }));
    }
  } catch (error) {
    console.error("API request failed", error);
    startResponseStream(stream, 500, "application/json");
    stream.write(JSON.stringify({ message: "Falha temporária ao processar a requisição." }));
  } finally {
    stream.end();
  }
});
