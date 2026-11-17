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
): Promise<string | undefined> {
  if (!USUARIOS_TABLE) {
    console.warn("USUARIOS_TABLE not configured; skipping user registration");
    return undefined;
  }

  const existing = await ddb.send(
    new GetItemCommand({
      TableName: USUARIOS_TABLE,
      Key: { usuario_id: { S: usuarioId } },
      ProjectionExpression: "usuario_id, ultima_intencao_id",
    }),
  );
  if (existing.Item) {
    return (existing.Item.ultima_intencao_id as { S?: string } | undefined)?.S;
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
      return undefined;
    }
    // Não bloqueia o chat: a próxima requisição tenta registrar de novo.
    console.error("ensureUsuario error:", err);
  }
  return undefined;
}

/**
 * Persiste o último intencao_id em Usuarios, para que a próxima mensagem não
 * dependa do modelo de lembrar o ID (nem do histórico corrompido).
 */
async function persistUltimaIntencao(
  usuarioId: string,
  intencaoId: string,
): Promise<void> {
  if (!USUARIOS_TABLE) return;
  try {
    await ddb.send(
      new UpdateItemCommand({
        TableName: USUARIOS_TABLE,
        Key: { usuario_id: { S: usuarioId } },
        UpdateExpression: "SET ultima_intencao_id = :id, atualizado_em = :agora",
        ExpressionAttributeValues: {
          ":id": { S: intencaoId },
          ":agora": { S: new Date().toISOString() },
        },
      }),
    );
  } catch (err) {
    console.error("persistUltimaIntencao error:", err);
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

exports.handler = async (event: {
  headers?: Record<string, string>;
  body?: string;
  requestContext?: { authorizer?: { claims?: Record<string, string> } };
}): Promise<LambdaResponse> => {
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

  const ultimaIntencaoId = await ensureUsuario(usuario_id, claims?.email);

  let body: ChatEventBody = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    body = {};
  }

  const messages = body.messages || [];

  // Histórico longo degrada a aderência do modelo (IDs inventados, turnos
  // fabricados). Mantemos só as últimas mensagens; o usuário pode limpar a conversa.
  // Mensagens do guard de "não finalizada" também saem: elas viram few-shot de erro.
  const MAX_HISTORY_MESSAGES = 12;
  const GUARD_MARK = "Nenhuma cobrança foi confirmada";
  const history = messages
    .slice(-MAX_HISTORY_MESSAGES)
    .filter((m) => {
      if (m.role !== "assistant") return true;
      const text = m.content.map((c) => c.text).join(" ");
      return !text.includes(GUARD_MARK);
    });

  const prompt = history
    .map((m) => `${m.role}: ${m.content.map((c) => c.text).join(" ")}`)
    .join("\n");

  const commandInput: InvokeAgentRuntimeCommandInput = {
    agentRuntimeArn,
    payload: Buffer.from(
      JSON.stringify({
        prompt,
        usuario_id,
        messages: history,
        intencao_id: ultimaIntencaoId,
      }),
    ),
    runtimeSessionId: `desafio1-${usuario_id}-${randomUUID()}`.slice(0, 200),
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

    if (typeof responseBody === "object" && responseBody !== null) {
      const intencaoId = (responseBody as { intencao_id?: unknown }).intencao_id;
      if (typeof intencaoId === "string" && intencaoId) {
        await persistUltimaIntencao(usuario_id, intencaoId);
      }
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(responseBody),
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
