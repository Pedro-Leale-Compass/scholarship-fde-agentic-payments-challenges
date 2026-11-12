/**
 * Lambda do chat — Desafio 1 (luiz-henrique).
 *
 * Chama o Agente Strands (Lambda do agent/) que orquestra Bedrock Converse
 * com as 3 tool Lambdas. Suporta dois modos através de variável de ambiente /
 * AWS profile, sem alterar código:
 *
 *   Desenvolvimento local:  AWS_PROFILE=local
 *                           → Lambda aponta p/ http://localhost:4566 (MiniStack → llama.cpp/Qwen3.5)
 *   Produção AWS:           AWS_PROFILE=desafio-1 (ou qualquer outro)
 *                           → Amazon Bedrock real (us-east-1, Claude Haiku)
 *
 * usuario_id vem exclusivamente do sub do token JWT Cognito (authorizer),
 * nunca do corpo da requisição nem do modelo.
 */

import {
  LambdaClient,
  InvokeCommand,
  type InvokeCommandInput,
} from "@aws-sdk/client-lambda";

const endpoint =
  process.env.BEDROCK_ENDPOINT_URL ||
  (process.env.AWS_PROFILE === "local" ? "http://localhost:4566" : undefined);

const lambdaConfig: {
  region: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
} = {
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
};
if (endpoint) {
  lambdaConfig.endpoint = endpoint;
  lambdaConfig.credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test",
  };
}

const lambdaClient = new LambdaClient(lambdaConfig);

const agentFnArn = process.env.AGENT_FN_ARN;
if (!agentFnArn) {
  throw new Error("AGENT_FN_ARN environment variable is required");
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
  body: string;
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

  const commandInput: InvokeCommandInput = {
    FunctionName: agentFnArn,
    InvocationType: "RequestResponse",
    Payload: JSON.stringify({
      usuario_id,
      messages,
    }),
  };

  try {
    const result = await lambdaClient.send(new InvokeCommand(commandInput));
    const payload = result.Payload
      ? JSON.parse(new TextDecoder().decode(result.Payload))
      : {};

    if (typeof payload === "object" && payload !== null && "statusCode" in payload) {
      return {
        statusCode: payload.statusCode as number,
        body: JSON.stringify(payload.body || payload),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify(payload),
    };
  } catch (err) {
    console.error("agent invoke error:", err);
    return {
      statusCode: 502,
      body: JSON.stringify({
        error: "agent_error",
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};
