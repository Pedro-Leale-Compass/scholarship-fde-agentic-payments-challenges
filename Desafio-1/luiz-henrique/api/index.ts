/**
 * Lambda do chat — Desafio 1 (luiz-henrique).
 *
 * Chama o Agente Strands no AgentCore Runtime via InvokeAgentRuntime.
 * O runtime executado é o Bedrock AgentCore Runtime de us-east-1.
 *
 * usuario_id vem exclusivamente do sub do token JWT Cognito (authorizer),
 * nunca do corpo da requisição nem do modelo.
 */

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  type InvokeAgentRuntimeCommandInput,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { randomUUID } from "crypto";

const bedrockAgentCore = new BedrockAgentCoreClient({
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
});

const ddb = new DynamoDBClient({
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
});

const USUARIOS_TABLE = process.env.USUARIOS_TABLE;
const CONVERSAS_TABLE = process.env.CONVERSAS_TABLE;
const LIMITE_INICIAL_CENTAVOS =
  Number(process.env.LIMITE_INICIAL_CENTAVOS) || 50000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.FRONTEND_URL || "",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const agentRuntimeArn = process.env.AGENT_RUNTIME_ARN;
if (!agentRuntimeArn) {
  throw new Error("AGENT_RUNTIME_ARN environment variable is required");
}

interface MessageContent {
  text: string;
}

interface Message {
  role: "user" | "assistant";
  content: MessageContent[];
}

interface ChatEventBody {
  messages?: Message[];
  conversa_id?: string;
}

interface ChatEvent {
  headers?: Record<string, string>;
  body?: string;
  httpMethod?: string;
  queryStringParameters?: Record<string, string | undefined> | null;
  requestContext?: {
    authorizer?: { claims?: Record<string, string> };
    httpMethod?: string;
  };
}

interface LambdaResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

/**
 * Garante que todo usuário autenticado exista em `Usuarios`, usando o sub do
 * Cognito como chave. Isso cobre usuários criados pelo console do Cognito
 * (fora do script de convite) e mantém o saldo inicial explícito.
 */
async function ensureUsuario(
  usuarioId: string,
  email?: string,
): Promise<void> {
  if (!USUARIOS_TABLE) {
    console.warn("USUARIOS_TABLE not configured; skipping user registration");
    return;
  }

  const existing = await ddb.send(
    new GetItemCommand({
      TableName: USUARIOS_TABLE,
      Key: { usuario_id: { S: usuarioId } },
      ProjectionExpression: "usuario_id",
    }),
  );
  if (existing.Item) {
    return;
  }

  const now = new Date().toISOString();
  try {
    await ddb.send(
      new PutItemCommand({
        TableName: USUARIOS_TABLE,
        Item: {
          usuario_id: { S: usuarioId },
          email: { S: email || "" },
          limite_centavos: { N: String(LIMITE_INICIAL_CENTAVOS) },
          gasto_total_centavos: { N: "0" },
          status: { S: "ativo" },
          origem: { S: "lazy" },
          criado_em: { S: now },
          atualizado_em: { S: now },
        },
        ConditionExpression: "attribute_not_exists(usuario_id)",
      }),
    );
    console.log(`usuario registrado: ${usuarioId}`);
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
      return;
    }
    // Não bloqueia o chat: a próxima requisição tenta registrar de novo.
    console.error("ensureUsuario error:", err);
  }
}

/**
 * Extrai o usuario_id do sub do token Cognito informado no cabeçalho Authorization.
 * Formato esperado: "Authorization: Bearer <JWT>" — o sub é lido do payload do JWT.
 * (Em produção o authorizer do API Gateway já valida o token; aqui apenas extraímos o sub.)
 */
function extractUsuarioId(headers: Record<string, string> | undefined): string | null {
  const auth = headers?.Authorization || headers?.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) return null;
    const decoded = Buffer.from(
      payloadPart.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    );
    const payload = JSON.parse(decoded.toString("utf-8"));
    return payload.sub || null;
  } catch (_) {
    return null;
  }
}


/**
 * Lê o estado de checkout da conversa. O chat Lambda não acessa a tabela de
 * intenções (requisito de menor privilégio); a validação final de dono, status
 * e expiração é feita pela tool realizar_compra. Se o status local não for
 * "pendente", o estado é limpo.
 */
async function getPendingIntencao(
  usuarioId: string,
  conversaId: string,
): Promise<string | undefined> {
  if (!CONVERSAS_TABLE) return undefined;

  try {
    const conversa = await ddb.send(
      new GetItemCommand({
        TableName: CONVERSAS_TABLE,
        Key: {
          conversa_id: { S: conversaId },
          usuario_id: { S: usuarioId },
        },
        ProjectionExpression: "pending_intencao_id, pending_status",
      }),
    );
    const pending = (
      conversa.Item?.pending_intencao_id as { S?: string } | undefined
    )?.S;
    const status = (
      conversa.Item?.pending_status as { S?: string } | undefined
    )?.S;
    if (!pending) return undefined;

    if (status && status !== "pendente") {
      await clearPendingIntencao(usuarioId, conversaId);
      return undefined;
    }

    return pending;
  } catch (err) {
    console.error("getPendingIntencao error:", err);
    return undefined;
  }
}

async function setPendingIntencao(
  usuarioId: string,
  conversaId: string,
  intencaoId: string,
): Promise<void> {
  if (!CONVERSAS_TABLE) return;
  const now = new Date().toISOString();
  try {
    await ddb.send(
      new UpdateItemCommand({
        TableName: CONVERSAS_TABLE,
        Key: {
          conversa_id: { S: conversaId },
          usuario_id: { S: usuarioId },
        },
        UpdateExpression:
          "SET pending_intencao_id = :id, pending_status = :status, atualizado_em = :now, criado_em = if_not_exists(criado_em, :now)",
        ExpressionAttributeValues: {
          ":id": { S: intencaoId },
          ":status": { S: "pendente" },
          ":now": { S: now },
        },
      }),
    );
  } catch (err) {
    console.error("setPendingIntencao error:", err);
  }
}

async function clearPendingIntencao(
  usuarioId: string,
  conversaId: string,
): Promise<void> {
  if (!CONVERSAS_TABLE) return;
  const now = new Date().toISOString();
  try {
    await ddb.send(
      new UpdateItemCommand({
        TableName: CONVERSAS_TABLE,
        Key: {
          conversa_id: { S: conversaId },
          usuario_id: { S: usuarioId },
        },
        UpdateExpression:
          "REMOVE pending_intencao_id, pending_status SET atualizado_em = :now",
        ExpressionAttributeValues: { ":now": { S: now } },
      }),
    );
  } catch (err) {
    console.error("clearPendingIntencao error:", err);
  }
}

const TERMINAL_PURCHASE_CODES = new Set([
  "COMPRA_APROVADA",
  "LIMITE_EXCEDIDO",
  "INTENCAO_JA_PAGA",
  "INTENCAO_CANCELADA",
  "INTENCAO_EXPIRADA",
  "INTENCAO_INDISPONIVEL",
  "USUARIO_NAO_ENCONTRADO",
]);

async function syncConversationState(
  usuarioId: string,
  conversaId: string,
  responseBody: unknown,
): Promise<void> {
  if (typeof responseBody !== "object" || responseBody === null) return;
  const payload = responseBody as {
    registered_intencao_id?: unknown;
    purchase?: { ok?: unknown; code?: unknown } | null;
  };

  const registered =
    typeof payload.registered_intencao_id === "string"
      ? payload.registered_intencao_id
      : undefined;
  if (registered) {
    await setPendingIntencao(usuarioId, conversaId, registered);
  }

  const purchase = payload.purchase;
  if (!purchase || typeof purchase !== "object") return;
  const code = typeof purchase.code === "string" ? purchase.code : undefined;
  if (purchase.ok === true || (code && TERMINAL_PURCHASE_CODES.has(code))) {
    await clearPendingIntencao(usuarioId, conversaId);
  }
}


async function getConversationItem(
  usuarioId: string,
  conversaId?: string,
): Promise<Record<string, unknown> | undefined> {
  if (!CONVERSAS_TABLE) return undefined;

  if (conversaId) {
    const item = await ddb.send(
      new GetItemCommand({
        TableName: CONVERSAS_TABLE,
        Key: {
          conversa_id: { S: conversaId },
          usuario_id: { S: usuarioId },
        },
      }),
    );
    return item.Item as Record<string, unknown> | undefined;
  }

  // Sem conversa_id: devolve a conversa mais recente do usuário.
  const result = await ddb.send(
    new QueryCommand({
      TableName: CONVERSAS_TABLE,
      IndexName: "usuario_id-index",
      KeyConditionExpression: "usuario_id = :usuario_id",
      ExpressionAttributeValues: { ":usuario_id": { S: usuarioId } },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  return result.Items?.[0] as Record<string, unknown> | undefined;
}

function readMessagesFromItem(
  item: Record<string, unknown> | undefined,
): Message[] {
  const raw = (item?.mensagens_json as { S?: string } | undefined)?.S;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Message[]) : [];
  } catch (_) {
    return [];
  }
}

async function handleGetConversas(
  usuarioId: string,
  event: ChatEvent,
): Promise<LambdaResponse> {
  const conversaId = event.queryStringParameters?.conversa_id?.trim();
  try {
    const item = await getConversationItem(usuarioId, conversaId);
    const storedConversaId = (
      item?.conversa_id as { S?: string } | undefined
    )?.S;
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        ok: true,
        conversa_id: storedConversaId || conversaId || null,
        messages: readMessagesFromItem(item),
        pending_intencao_id:
          (item?.pending_intencao_id as { S?: string } | undefined)?.S || null,
      }),
    };
  } catch (err) {
    console.error("getConversas error:", err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ ok: false, error: "conversation_read_error" }),
    };
  }
}

/**
 * Persiste o histórico completo da conversa. O frontend envia o histórico a
 * cada turno; aqui gravamos usuário + assistente para GET /conversas e reload.
 */
async function storeConversationMessages(
  usuarioId: string,
  conversaId: string,
  messages: Message[],
): Promise<void> {
  if (!CONVERSAS_TABLE) return;
  const now = new Date().toISOString();
  try {
    await ddb.send(
      new UpdateItemCommand({
        TableName: CONVERSAS_TABLE,
        Key: {
          conversa_id: { S: conversaId },
          usuario_id: { S: usuarioId },
        },
        UpdateExpression:
          "SET mensagens_json = :messages, atualizado_em = :now, criado_em = if_not_exists(criado_em, :now)",
        ExpressionAttributeValues: {
          ":messages": { S: JSON.stringify(messages) },
          ":now": { S: now },
        },
      }),
    );
  } catch (err) {
    // Não bloqueia o chat se o histórico não couber/gravar.
    console.error("storeConversationMessages error:", err);
  }
}

exports.handler = async (event: ChatEvent): Promise<LambdaResponse> => {
  const headers = event.headers || {};
  const claims = event.requestContext?.authorizer?.claims;
  const usuario_id = claims?.sub || extractUsuarioId(headers);

  if (!usuario_id) {
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "missing or invalid token" }),
    };
  }

  const method = event.httpMethod || event.requestContext?.httpMethod || "POST";
  if (method === "GET") {
    return handleGetConversas(usuario_id, event);
  }

  await ensureUsuario(usuario_id, claims?.email);

  let body: ChatEventBody = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    body = {};
  }

  const messages = body.messages || [];
  const conversaId =
    typeof body.conversa_id === "string" && body.conversa_id.trim()
      ? body.conversa_id.trim().slice(0, 128)
      : randomUUID();
  const pendingIntencaoId = await getPendingIntencao(usuario_id, conversaId);

  // O PDF exige o histórico completo a cada turno. Não truncamos: falhas também
  // ficam visíveis para o modelo (esconder erro faz parecer que a intenção segue pendente).
  const history = messages;

  const prompt = history
    .map((m) => `${m.role}: ${m.content.map((c) => c.text).join(" ")}`)
    .join("\n");

  const commandInput: InvokeAgentRuntimeCommandInput = {
    agentRuntimeArn,
    payload: Buffer.from(
      JSON.stringify({
        prompt,
        usuario_id,
        conversa_id: conversaId,
        pending_intencao_id: pendingIntencaoId,
        messages: history,
      }),
    ),
    runtimeSessionId: `desafio1-${usuario_id}-${conversaId}`.slice(0, 200),
    contentType: "application/json",
    accept: "application/json",
    qualifier: "DEFAULT",
  };

  try {
    const result = await bedrockAgentCore.send(new InvokeAgentRuntimeCommand(commandInput));
    const responseStream = result.response;

    let responseBody: unknown = {};
    if (responseStream) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of responseStream as unknown as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      const combined = Buffer.concat(chunks);
      responseBody = combined.length > 0 ? JSON.parse(combined.toString("utf-8")) : {};
    }

    if (typeof responseBody === "object" && responseBody !== null && "statusCode" in responseBody) {
      return {
        statusCode: (responseBody as { statusCode: number }).statusCode,
        headers: CORS_HEADERS,
        body: JSON.stringify((responseBody as { body?: unknown }).body || responseBody),
      };
    }

    await syncConversationState(usuario_id, conversaId, responseBody);

    const assistantReply = (responseBody as { reply?: unknown } | null)?.reply;
    if (typeof assistantReply === "string" && assistantReply.trim()) {
      await storeConversationMessages(usuario_id, conversaId, [
        ...history,
        { role: "assistant", content: [{ text: assistantReply }] },
      ]);
    }

    const finalBody =
      typeof responseBody === "object" && responseBody !== null
        ? { ...responseBody, conversa_id: conversaId }
        : { conversa_id: conversaId, result: responseBody };

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(finalBody),
    };
  } catch (err) {
    console.error("agent runtime invoke error:", err);
    return {
      statusCode: 502,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: "agent_error",
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};
