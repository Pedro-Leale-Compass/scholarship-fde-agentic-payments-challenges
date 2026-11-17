import { pipeline } from "node:stream/promises";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { DynamoDBClient, PutItemCommand, ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";

const { AGENTE_ARN, ORIGEM_PERMITIDA, TABELA_USUARIOS } = process.env;
const LIMITE_PADRAO = process.env.LIMITE_PADRAO ?? "1500";

const clienteAgente = new BedrockAgentCoreClient({});
const clienteDynamo = new DynamoDBClient({});

function cabecalhos(tipo) {
  return { "Content-Type": tipo, "Access-Control-Allow-Origin": ORIGEM_PERMITIDA };
}

function responderErro(stream, status, mensagem) {
  const saida = awslambda.HttpResponseStream.from(stream, {
    statusCode: status,
    headers: cabecalhos("application/json; charset=utf-8"),
  });
  saida.write(JSON.stringify({ erro: mensagem }));
  saida.end();
}

// Cria o usuario com o limite padrao na primeira vez. Se ja existir, nao mexe.
async function garantirUsuario(usuarioId, email) {
  try {
    await clienteDynamo.send(
      new PutItemCommand({
        TableName: TABELA_USUARIOS,
        Item: {
          usuario_id: { S: usuarioId },
          nome: { S: email ?? "" },
          limite_restante: { N: LIMITE_PADRAO },
        },
        ConditionExpression: "attribute_not_exists(usuario_id)",
      })
    );
  } catch (erro) {
    if (!(erro instanceof ConditionalCheckFailedException)) throw erro;
  }
}

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  // 1. Identidade: vem do token ja validado pelo API Gateway, nunca do corpo.
  const claims = event.requestContext?.authorizer?.claims ?? {};
  const usuarioId = claims.sub;
  if (!usuarioId) return responderErro(responseStream, 401, "nao autenticado");

  // 2. Mensagem.
  let corpo;
  try {
    const bruto = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body;
    corpo = JSON.parse(bruto || "{}");
  } catch {
    return responderErro(responseStream, 400, "corpo invalido");
  }
  const mensagem = (corpo.mensagem ?? "").trim();
  if (!mensagem) return responderErro(responseStream, 400, "mensagem vazia");

  // 3. Limite do usuario na primeira mensagem.
  await garantirUsuario(usuarioId, claims.email);

  // 4. Chama o agente. Uma sessao do AgentCore por usuario.
  let resposta;
  try {
    resposta = await clienteAgente.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: AGENTE_ARN,
        runtimeSessionId: `sessao-${usuarioId}`,
        contentType: "application/json",
        accept: "text/event-stream",
        payload: Buffer.from(JSON.stringify({ usuario_id: usuarioId, mensagem })),
      })
    );
  } catch (erro) {
    console.error("[chat] falha ao chamar o agente:", erro);
    return responderErro(responseStream, 502, "falha ao falar com o agente");
  }

  // 5. Repassa os pedacos do agente direto para o cliente.
  const saida = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: { ...cabecalhos("text/event-stream; charset=utf-8"), "Cache-Control": "no-cache" },
  });
  await pipeline(resposta.response, saida);
});