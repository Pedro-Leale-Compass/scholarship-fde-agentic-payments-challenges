import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent } from "aws-lambda";

export const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export function env(nome: string): string {
  const valor = process.env[nome];
  if (!valor) throw new Error(`Variavel de ambiente ${nome} nao configurada`);
  return valor;
}

/**
 * usuario_id = `sub` do token do Cognito, ja validado pelo autorizador do
 * API Gateway. NUNCA vem do corpo da requisicao.
 */
export function usuarioDoToken(evento: APIGatewayProxyEvent): string | undefined {
  const sub = evento.requestContext?.authorizer?.claims?.sub;
  return typeof sub === "string" && sub ? sub : undefined;
}

/** CORS: devolve a origem so se ela estiver na lista permitida. */
export function cabecalhosCors(evento: APIGatewayProxyEvent): Record<string, string> {
  const permitidas = (process.env.ORIGENS_PERMITIDAS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  const origem = evento.headers?.origin ?? evento.headers?.Origin;
  if (!origem || !permitidas.includes(origem)) return {};
  return {
    "Access-Control-Allow-Origin": origem,
    "Access-Control-Allow-Credentials": "false",
    Vary: "Origin",
  };
}

/* ------------------------------------------------------------------ */
/* Tabela de conversas                                                  */
/*   PK user_id | SK "<ISO 8601>#<seq 3 digitos>" | mensagem (JSON)     */
/* Uma linha por mensagem, no formato Bedrock Converse que o agente usa. */
/* ------------------------------------------------------------------ */

export type MensagemConverse = { role: "user" | "assistant"; content: unknown[] };

export async function carregarHistorico(userId: string): Promise<MensagemConverse[]> {
  const mensagens: MensagemConverse[] = [];
  let inicio: Record<string, unknown> | undefined;
  do {
    const pagina = await db.send(
      new QueryCommand({
        TableName: env("TABELA_CONVERSAS"),
        KeyConditionExpression: "user_id = :u",
        ExpressionAttributeValues: { ":u": userId },
        ExclusiveStartKey: inicio,
        ConsistentRead: true,
      }),
    );
    for (const item of pagina.Items ?? []) mensagens.push(JSON.parse(item.mensagem as string));
    inicio = pagina.LastEvaluatedKey;
  } while (inicio);
  return mensagens;
}

async function emLotes(pedidos: Record<string, unknown>[]): Promise<void> {
  const tabela = env("TABELA_CONVERSAS");
  for (let i = 0; i < pedidos.length; i += 25) {
    let pendentes: Record<string, unknown>[] | undefined = pedidos.slice(i, i + 25);
    for (let tentativa = 0; pendentes?.length && tentativa < 5; tentativa++) {
      const r = await db.send(new BatchWriteCommand({ RequestItems: { [tabela]: pendentes as never } }));
      pendentes = r.UnprocessedItems?.[tabela] as Record<string, unknown>[] | undefined;
      if (pendentes?.length) await new Promise((ok) => setTimeout(ok, 100 * 2 ** tentativa));
    }
  }
}

export async function salvarMensagens(userId: string, mensagens: MensagemConverse[]): Promise<void> {
  const agora = new Date().toISOString();
  await emLotes(
    mensagens.map((m, i) => ({
      PutRequest: {
        Item: { user_id: userId, sk: `${agora}#${String(i).padStart(3, "0")}`, mensagem: JSON.stringify(m) },
      },
    })),
  );
}

export async function apagarHistorico(userId: string): Promise<number> {
  const chaves: { user_id: string; sk: string }[] = [];
  let inicio: Record<string, unknown> | undefined;
  do {
    const pagina = await db.send(
      new QueryCommand({
        TableName: env("TABELA_CONVERSAS"),
        KeyConditionExpression: "user_id = :u",
        ExpressionAttributeValues: { ":u": userId },
        ProjectionExpression: "user_id, sk",
        ExclusiveStartKey: inicio,
      }),
    );
    chaves.push(...((pagina.Items ?? []) as { user_id: string; sk: string }[]));
    inicio = pagina.LastEvaluatedKey;
  } while (inicio);
  await emLotes(chaves.map((Key) => ({ DeleteRequest: { Key } })));
  return chaves.length;
}
