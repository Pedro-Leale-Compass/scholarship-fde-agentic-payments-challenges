import { randomUUID } from "crypto";
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  DeleteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { CognitoJwtVerifier } from "aws-jwt-verify";

const CONEXOES_TABLE = process.env.CONEXOES_TABLE;
const CHAT_FUNCTION_NAME = process.env.CHAT_FUNCTION_NAME;
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const REGION = process.env.AWS_REGION || "us-east-1";

const ddb = new DynamoDBClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });

interface WsEvent {
  requestContext: {
    routeKey: string;
    connectionId: string;
    domainName: string;
    stage: string;
  };
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string;
}

interface LambdaResponse {
  statusCode: number;
  body?: string;
}

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

function getVerifier(): ReturnType<typeof CognitoJwtVerifier.create> {
  if (!COGNITO_USER_POOL_ID || !COGNITO_CLIENT_ID) {
    throw new Error("COGNITO_USER_POOL_ID/COGNITO_CLIENT_ID not configured");
  }
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: COGNITO_USER_POOL_ID,
      tokenUse: "id",
      clientId: COGNITO_CLIENT_ID,
    });
  }
  return verifier;
}

function connectionItem(event: WsEvent) {
  return { connection_id: { S: event.requestContext.connectionId } };
}

async function postToConnection(
  event: WsEvent,
  message: unknown,
): Promise<void> {
  const endpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
  const api = new ApiGatewayManagementApiClient({ endpoint, region: REGION });
  await api.send(
    new PostToConnectionCommand({
      ConnectionId: event.requestContext.connectionId,
      Data: Buffer.from(JSON.stringify(message)),
    }),
  );
}

async function handleConnect(event: WsEvent): Promise<LambdaResponse> {
  if (!CONEXOES_TABLE) return { statusCode: 500, body: "CONEXOES_TABLE missing" };

  const token = event.queryStringParameters?.token;
  if (!token) return { statusCode: 401, body: "missing token" };

  let usuarioId: string;
  try {
    const payload = await getVerifier().verify(token);
    usuarioId = payload.sub;
  } catch (err) {
    console.warn("websocket auth rejected:", err);
    return { statusCode: 401, body: "invalid token" };
  }

  const conversaId =
    event.queryStringParameters?.conversa_id?.trim() || randomUUID();
  const now = new Date().toISOString();
  const expiraEm = Math.floor(Date.now() / 1000) + 60 * 60;

  await ddb.send(
    new PutItemCommand({
      TableName: CONEXOES_TABLE,
      Item: {
        ...connectionItem(event),
        usuario_id: { S: usuarioId },
        conversa_id: { S: conversaId },
        conectado_em: { S: now },
        expira_em: { N: String(expiraEm) },
      },
    }),
  );

  // Não envie mensagem durante $connect: a conexão ainda não está pronta
  // para postToConnection (pode retornar 410 GoneException). O cliente envia
  // a primeira mensagem no onopen e usa o conversa_id da query.
  return { statusCode: 200 };
}

async function handleDisconnect(event: WsEvent): Promise<LambdaResponse> {
  if (!CONEXOES_TABLE) return { statusCode: 200 };
  await ddb.send(
    new DeleteItemCommand({
      TableName: CONEXOES_TABLE,
      Key: connectionItem(event),
    }),
  );
  return { statusCode: 200 };
}

async function handleDefault(event: WsEvent): Promise<LambdaResponse> {
  if (!CONEXOES_TABLE || !CHAT_FUNCTION_NAME) {
    return { statusCode: 500, body: "websocket not configured" };
  }

  const connection = await ddb.send(
    new GetItemCommand({
      TableName: CONEXOES_TABLE,
      Key: connectionItem(event),
    }),
  );
  if (!connection.Item?.usuario_id?.S) {
    return { statusCode: 401, body: "connection not authenticated" };
  }

  const usuarioId = connection.Item.usuario_id.S;
  const conversationFromConnection = connection.Item.conversa_id?.S || randomUUID();

  let body: {
    action?: string;
    conversa_id?: string;
    messages?: unknown;
  } = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    await postToConnection(event, { type: "error", message: "invalid json" });
    return { statusCode: 200 };
  }

  if (body.action === "ping") {
    await postToConnection(event, { type: "pong" });
    return { statusCode: 200 };
  }

  if (!Array.isArray(body.messages)) {
    await postToConnection(event, {
      type: "error",
      message: "messages must be an array",
    });
    return { statusCode: 200 };
  }

  const conversaId = body.conversa_id?.trim() || conversationFromConnection;
  const chatEvent = {
    httpMethod: "POST",
    headers: {},
    requestContext: {
      authorizer: { claims: { sub: usuarioId } },
    },
    body: JSON.stringify({
      conversa_id: conversaId,
      messages: body.messages,
    }),
  };

  try {
    const result = await lambda.send(
      new InvokeCommand({
        FunctionName: CHAT_FUNCTION_NAME,
        Payload: Buffer.from(JSON.stringify(chatEvent)),
      }),
    );
    const raw = Buffer.from(result.Payload || new Uint8Array()).toString("utf-8");
    const envelope = raw ? JSON.parse(raw) : {};
    const payload =
      typeof envelope.body === "string"
        ? JSON.parse(envelope.body)
        : envelope.body || envelope;
    await postToConnection(event, {
      type: "chat",
      conversa_id: conversaId,
      ...payload,
    });
  } catch (err) {
    console.error("websocket chat error:", err);
    try {
      await postToConnection(event, {
        type: "error",
        message: "chat failed",
      });
    } catch (_) {
      // conexão provavelmente já fechou
    }
  }

  return { statusCode: 200 };
}

exports.handler = async (event: WsEvent): Promise<LambdaResponse> => {
  switch (event.requestContext.routeKey) {
    case "$connect":
      return handleConnect(event);
    case "$disconnect":
      return handleDisconnect(event);
    default:
      return handleDefault(event);
  }
};
