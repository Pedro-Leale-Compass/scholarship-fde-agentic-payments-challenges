import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb"

// Criado fora do handler para ser reaproveitado entre invocações do mesmo container.
export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
})

type NomeTabela = "TABELA_USUARIOS" | "TABELA_PRODUTOS" | "TABELA_INTENCOES" | "TABELA_TRANSACOES"

// Os nomes vêm de variáveis de ambiente definidas no CloudFormation: nada fixo no código.
export function tabela(nome: NomeTabela): string {
    const valor = process.env[nome]
    if (!valor) throw new Error(`Variável de ambiente ${nome} não configurada`)
    return valor
}
