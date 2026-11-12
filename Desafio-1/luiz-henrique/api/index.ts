/**
 * Lambda do chat — Desafio 1 (luiz-henrique).
 *
 * Chama o Agente Strands via Bedrock-Runtime. Suporta dois modos através de
 * variável de ambiente / AWS profile, sem alterar código:
 *
 *   Desenvolvimento local:  AWS_PROFILE=local
 *                           → BEDROCK_ENDPOINT_URL=http://localhost:4566
 *                           → MiniStack (Bedrock emulator) → llama.cpp (Qwen3.5 2B Q8)
 *   Produção AWS:           AWS_PROFILE=desafio-1 (ou qualquer outro)
 *                           → Amazon Bedrock real (us-east-1, Claude Haiku)
 *
 * usuario_id vem exclusivamente do sub do token JWT Cognito (authorizer),
 * nunca do corpo da requisição nem do modelo.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";

const MODEL_ID = process.env.BEDROCK_MODEL_ID || "qwen3.5";

// Endpoint do Bedrock: env var BEDROCK_ENDPOINT_URL tem prioridade.
// Fallback: AWS_PROFILE=local aponta para o MiniStack local (:4566).
let bedrockEndpoint = process.env.BEDROCK_ENDPOINT_URL;
if (!bedrockEndpoint && process.env.AWS_PROFILE === "local") {
  bedrockEndpoint = "http://localhost:4566";
}

const bedrockConfig: {
  region: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
} = {
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
};
if (bedrockEndpoint) {
  bedrockConfig.endpoint = bedrockEndpoint;
  bedrockConfig.credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test",
  };
}

const bedrock = new BedrockRuntimeClient(bedrockConfig);

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
 * Converte a lista de mensagens do formato da requisição para o formato Bedrock Converse.
 */
function toBedrockMessages(messages: Message[] | undefined): {
  role: "user" | "assistant";
  content: { text: string }[];
}[] {
  return (messages || []).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: (m.content || []).map((c) => ({ text: c.text || "" })),
  }));
}

interface LambdaResponse {
  statusCode: number;
  body: string;
}

exports.handler = async (event: {
  headers?: Record<string, string>;
  body?: string;
}): Promise<LambdaResponse> => {
  const headers = event.headers || {};
  const usuario_id = extractUsuarioId(headers);

  if (!usuario_id) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "missing or invalid token" }),
    };
  }

  let body: ChatEventBody = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    body = {};
  }

  const messages = body.messages || [];
  const userMessage = messages[messages.length - 1];
  const userText =
    (userMessage &&
      userMessage.content &&
      userMessage.content[0] &&
      userMessage.content[0].text) ||
    "";

  try {
    const command = new ConverseCommand({
      modelId: MODEL_ID,
      messages: toBedrockMessages(messages),
      inferenceConfig: { maxTokens: 400, temperature: 0.7 },
    });

    const response: ConverseCommandOutput = await bedrock.send(command);

    const outputText =
      response.output?.message?.content
        ?.filter((c) => "text" in c && typeof c.text === "string")
        .map((c) => c.text)
        .join("") || "";

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        usuario_id,
        model: MODEL_ID,
        endpoint: bedrockEndpoint || "aws-bedrock",
        reply: outputText,
        usage: response.usage || null,
        stopReason: response.stopReason || null,
      }),
    };
  } catch (err) {
    console.error("Bedrock Converse error:", err);
    return {
      statusCode: 502,
      body: JSON.stringify({
        error: "bedrock_error",
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};
