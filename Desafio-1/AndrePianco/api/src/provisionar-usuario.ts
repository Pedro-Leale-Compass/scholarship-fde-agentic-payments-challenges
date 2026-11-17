import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { PostAuthenticationTriggerEvent } from "aws-lambda";
import { db, env } from "./comum.js";

/**
 * Gatilho PostAuthentication do Cognito: roda a cada login.
 *
 * Garante que o usuario tenha uma linha na tabela de usuarios com o limite
 * de gasto. So cria se ainda nao existir (escrita condicional), entao nunca
 * reseta o limite de quem ja comprou. Assim um usuario convidado pelo
 * console do Cognito (ex.: o instrutor) ja entra com limite.
 *
 * Permissao: apenas dynamodb:PutItem na tabela de usuarios.
 */
export async function handler(evento: PostAuthenticationTriggerEvent): Promise<PostAuthenticationTriggerEvent> {
  const atributos = evento.request.userAttributes;
  const limite = Number(process.env.LIMITE_PADRAO ?? 1000);
  try {
    await db.send(
      new PutCommand({
        TableName: env("TABELA_USUARIOS"),
        Item: {
          user_id: atributos.sub,
          email: atributos.email,
          limite_total: limite,
          limite_disponivel: limite,
          criado_em: new Date().toISOString(),
        },
        ConditionExpression: "attribute_not_exists(user_id)",
      }),
    );
    console.log(JSON.stringify({ tipo: "usuario_provisionado", user_id: atributos.sub, limite }));
  } catch (e) {
    if (!(e instanceof ConditionalCheckFailedException)) {
      // Nao bloqueia o login: sem a linha, as compras so serao recusadas
      // por limite (comportamento seguro), e o proximo login tenta de novo.
      console.error(JSON.stringify({ tipo: "falha_provisionar", erro: String(e) }));
    }
  }
  return evento;
}
