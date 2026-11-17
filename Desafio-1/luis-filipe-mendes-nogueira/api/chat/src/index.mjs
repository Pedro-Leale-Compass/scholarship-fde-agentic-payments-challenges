import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";

import { RepositorioConversas } from "./repositorio.mjs";
import { criarAplicacao } from "./aplicacao.mjs";
import { lerSse } from "./sse.mjs";

const regiao = process.env.AWS_REGION;
const arnRuntime = process.env.AGENT_RUNTIME_ARN;

const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: regiao, maxAttempts: 2 }),
  {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  },
);

// Repetir a chamada inteira poderia repetir uma ação do agente.
const agentcore = new BedrockAgentCoreClient({
  region: regiao,
  maxAttempts: 1,
});

async function* invocar(payload, sessao) {
  const controle = new AbortController();
  let corpo;

  const prazo = setTimeout(() => {
    controle.abort();
    corpo?.destroy?.(new Error("Prazo da execução encerrado."));
  }, 90_000);

  prazo.unref();

  try {
    const resultado = await agentcore.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: arnRuntime,
        qualifier: "DEFAULT",
        runtimeSessionId: sessao,
        contentType: "application/json",
        accept: "text/event-stream",
        payload: Buffer.from(JSON.stringify(payload), "utf8"),
      }),
      { abortSignal: controle.signal },
    );

    corpo = resultado.response;

    if (
      resultado.statusCode !== 200 ||
      !resultado.contentType?.startsWith("text/event-stream") ||
      !corpo?.[Symbol.asyncIterator]
    ) {
      throw new Error("Resposta inesperada do AgentCore.");
    }

    yield* lerSse(corpo);
  } finally {
    clearTimeout(prazo);
    corpo?.destroy?.();

    try {
      await agentcore.send(
        new StopRuntimeSessionCommand({
          agentRuntimeArn: arnRuntime,
          qualifier: "DEFAULT",
          runtimeSessionId: sessao,
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
    } catch (erro) {
      if (erro.name !== "ResourceNotFoundException") {
        console.error("CHAT_FALHA_AO_ENCERRAR_SESSAO");
      }
    }
  }
}

const atender = criarAplicacao({
  repositorio: new RepositorioConversas(
    dynamo,
    process.env.CONVERSAS_TABLE,
  ),
  invocar,
  clientId: process.env.COGNITO_CLIENT_ID,
  origem: process.env.FRONTEND_ORIGIN,
});

export const handler = awslambda.streamifyResponse(
  async (evento, fluxoOriginal) => {
    let fluxo;

    const abrirResposta = (metadados) => {
      if (fluxo) throw new Error("Resposta já iniciada.");

      fluxo = awslambda.HttpResponseStream.from(
        fluxoOriginal,
        metadados,
      );

      fluxo.on("error", () => {});

      return async (texto) => {
        // A execução continua para persistir o resultado caso o navegador saia.
        if (fluxo.destroyed || fluxo.writableEnded) return;

        await new Promise((resolve) => {
          try {
            fluxo.write(texto, () => resolve());
          } catch {
            resolve();
          }
        });
      };
    };

    try {
      await atender(evento, abrirResposta);
    } finally {
      const destino = fluxo ?? fluxoOriginal;

      if (!destino.destroyed && !destino.writableEnded) {
        destino.end();
      }
    }
  },
);
