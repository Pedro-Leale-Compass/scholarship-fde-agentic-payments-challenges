
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { createHash } from "node:crypto";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";

const client = new BedrockAgentCoreClient({
  region: process.env.AWS_REGION || "us-east-1",
});

const agentRuntimeArn = process.env.AGENT_RUNTIME_ARN;

type ChatRequest = {
  mensagem?: unknown;
  sessao_id?: unknown;
};

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer =
  async (event) => {
    // 1. Identidade obtida do JWT validado pelo API Gateway.
    const userId = event.requestContext.authorizer?.jwt?.claims?.sub;

    if (typeof userId !== "string" || !userId) {
      return {
        statusCode: 401,
        body: JSON.stringify({
          erro: "Usuário não autenticado.",
        }),
      };
    }

    if (!agentRuntimeArn) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          erro: "AgentCore não configurado.",
        }),
      };
    }

    // 2. Validação do corpo da requisição.
    let body: ChatRequest;

    try {
      body = JSON.parse(event.body || "{}");

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("Corpo inválido");
      }
    } catch {
      return {
        statusCode: 400,
        body: JSON.stringify({
          erro: "JSON inválido.",
        }),
      };
    }

    const { mensagem, sessao_id } = body;

    // 3. Validação da mensagem.
    if (
      typeof mensagem !== "string" ||
      !mensagem.trim() ||
      mensagem.length > 4000
    ) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          erro: "Informe uma mensagem válida de até 4000 caracteres.",
        }),
      };
    }

    // 4. Validação do UUID da sessão.
    if (
      typeof sessao_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        sessao_id
      )
    ) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          erro: "Identificador de sessão inválido.",
        }),
      };
    }

    try {
      // 5. Vincula a sessão ao usuário autenticado.
      const sessionId = createHash("sha256")
        .update(`${userId}:${sessao_id}`)
        .digest("hex");

      // 6. Invoca o AgentCore.
      const command = new InvokeAgentRuntimeCommand({
        agentRuntimeArn,
        runtimeSessionId: sessionId,
        payload: new TextEncoder().encode(
          JSON.stringify({
            prompt: mensagem.trim(),
            usuario_id: userId,
          })
        ),
        contentType: "application/json",
        accept: "application/json",
      });

      const response = await client.send(command);

      const raw = await response.response?.transformToString();

      if (!raw) {
        throw new Error("Resposta vazia do AgentCore");
      }

      const resultado = JSON.parse(raw);

      // 7. Retorna a resposta ao frontend.
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          resposta: resultado.resposta ?? resultado,
        }),
      };
    } catch (error) {
      console.error("Erro ao invocar AgentCore:", error);

      return {
        statusCode: 502,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          erro: "Não foi possível obter resposta do agente.",
        }),
      };
    }
  };
