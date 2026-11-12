/**
 * Lambda do chat — Desafio 1 (luiz-henrique).
 *
 * Chama o Agente Strands no AgentCore Runtime via InvokeAgentRuntime.
 * Suporta dois modos através de variável de ambiente / AWS profile:
 *
 *   Desenvolvimento local:  AWS_PROFILE=local
 *                           → aponta p/ http://localhost:4566 (MiniStack bedrock-agentcore-data-plane)
 *   Produção AWS:           AWS_PROFILE=desafio-1 (ou qualquer outro)
 *                           → Amazon Bedrock AgentCore Runtime real (us-east-1)
 *
 * usuario_id vem exclusivamente do sub do token JWT Cognito (authorizer),
 * nunca do corpo da requisição nem do modelo.
 */

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  type InvokeAgentRuntimeCommandInput,
} from "@aws-sdk/client-bedrock-agentcore";

const endpoint =
  process.env.BEDROCK_ENDPOINT_URL ||
  (process.env.AWS_PROFILE === "local" ? "http://localhost:4566" : undefined);

const clientConfig: {
  region: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
} = {
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
};
if (endpoint) {
  clientConfig.endpoint = endpoint;
  clientConfig.credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test",
  };
}

const bedrockAgentCore = new BedrockAgentCoreClient(clientConfig);

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

  const prompt = messages
    .map((m) => `${m.role}: ${m.content.map((c) => c.text).join(" ")}`)
    .join("\n");

  const commandInput: InvokeAgentRuntimeCommandInput = {
    agentRuntimeArn,
    payload: Buffer.from(
      JSON.stringify({
        prompt,
        usuario_id,
        messages,
      }),
    ),
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
        body: JSON.stringify((responseBody as { body?: unknown }).body || responseBody),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify(responseBody),
    };
  } catch (err) {
    console.error("agent runtime invoke error:", err);
    return {
      statusCode: 502,
      body: JSON.stringify({
        error: "agent_error",
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};
