import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import type { APIGatewayProxyEvent } from "aws-lambda";
import type { Readable } from "node:stream";
import {
  cabecalhosCors,
  carregarHistorico,
  env,
  salvarMensagens,
  usuarioDoToken,
  type MensagemConverse,
} from "./comum.js";

const agentcore = new BedrockAgentCoreClient({});
const MAX_CARACTERES = 2000;

/**
 * POST /chat -- Lambda com response streaming atras do API Gateway.
 *
 * 1. Pega o usuario_id do `sub` do token (o autorizador Cognito do API
 *    Gateway ja recusou com 401 quem nao tem token valido).
 * 2. Carrega o historico COMPLETO do usuario no DynamoDB.
 * 3. Invoca o agente no AgentCore com user_id + historico + mensagem.
 * 4. Repassa o stream de eventos (SSE) para o navegador conforme chega.
 * 5. No evento "fim", grava as mensagens novas do turno no historico.
 *
 * Permissoes: invocar o runtime do agente e ler/gravar a tabela de
 * conversas. Nada de Bedrock nem das tabelas de intencoes/transacoes.
 */
export const handler = awslambda.streamifyResponse<APIGatewayProxyEvent>(async (evento, resposta) => {
  const cors = cabecalhosCors(evento);
  const responderJson = (statusCode: number, corpo: unknown) => {
    const s = awslambda.HttpResponseStream.from(resposta, {
      statusCode,
      headers: { "Content-Type": "application/json", ...cors },
    });
    s.write(JSON.stringify(corpo));
    s.end();
  };

  const userId = usuarioDoToken(evento);
  if (!userId) return responderJson(401, { erro: "Nao autenticado." });

  let mensagem: unknown;
  try {
    mensagem = JSON.parse(evento.body ?? "{}").mensagem;
  } catch {
    return responderJson(400, { erro: "Corpo da requisicao invalido." });
  }
  if (typeof mensagem !== "string" || !mensagem.trim()) {
    return responderJson(400, { erro: "Envie o campo 'mensagem' com o texto." });
  }
  if (mensagem.length > MAX_CARACTERES) {
    return responderJson(400, { erro: `Mensagem muito longa (maximo ${MAX_CARACTERES} caracteres).` });
  }

  const stream = awslambda.HttpResponseStream.from(resposta, {
    statusCode: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      ...cors,
    },
  });
  const enviar = (ev: Record<string, unknown>) => stream.write(`data: ${JSON.stringify(ev)}\n\n`);

  let terminou = false;
  try {
    const historico = await carregarHistorico(userId);
    const r = await agentcore.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: env("AGENTE_RUNTIME_ARN"),
        // Uma sessao (microVM) por usuario: >= 33 caracteres, isolada por sub.
        runtimeSessionId: `sessao-usuario-${userId}`,
        contentType: "application/json",
        accept: "text/event-stream",
        payload: Buffer.from(JSON.stringify({ user_id: userId, historico, mensagem: mensagem.trim() })),
      }),
    );

    // O agente responde em SSE: linhas "data: {json}". Repassamos cada
    // evento assim que ele chega e guardamos o "fim" para persistir.
    let pendente = "";
    for await (const pedaco of r.response as Readable) {
      pendente += Buffer.from(pedaco).toString("utf8");
      let quebra: number;
      while ((quebra = pendente.indexOf("\n")) >= 0) {
        const linha = pendente.slice(0, quebra).trim();
        pendente = pendente.slice(quebra + 1);
        if (!linha.startsWith("data:")) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(linha.slice(5).trim());
        } catch {
          continue;
        }
        if (ev.tipo === "fim") {
          await salvarMensagens(userId, (ev.mensagens as MensagemConverse[]) ?? []);
          enviar({ tipo: "fim", motivo: ev.motivo });
          terminou = true;
        } else {
          enviar(ev);
        }
      }
    }
    if (!terminou) {
      enviar({ tipo: "erro", mensagem: "A resposta do assistente foi interrompida. Tente novamente." });
    }
  } catch (e) {
    console.error(JSON.stringify({ tipo: "falha_chat", erro: String(e), stack: (e as Error)?.stack }));
    enviar({ tipo: "erro", mensagem: "Não consegui falar com o assistente agora. Tente novamente em instantes." });
  } finally {
    stream.end();
  }
});
