import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/** Cliente unico, reaproveitado entre invocacoes da mesma instancia. */
export const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

function env(nome: string): string {
  const valor = process.env[nome];
  if (!valor) throw new Error(`Variavel de ambiente ${nome} nao configurada`);
  return valor;
}

/**
 * Nomes das tabelas vem do CDK por variavel de ambiente. Cada Lambda so
 * recebe as variaveis (e as permissoes) das tabelas que de fato usa, por
 * isso a leitura e preguicosa.
 */
export const tabelas = {
  catalogo: () => env("TABELA_CATALOGO"),
  usuarios: () => env("TABELA_USUARIOS"),
  intencoes: () => env("TABELA_INTENCOES"),
  transacoes: () => env("TABELA_TRANSACOES"),
};
