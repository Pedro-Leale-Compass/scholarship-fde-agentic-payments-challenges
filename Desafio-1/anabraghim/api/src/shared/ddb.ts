import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb"

// Criado fora do handler para ser reaproveitado entre invocações do mesmo container.
export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
})

type Variavel = "TABELA_CONVERSAS" | "TABELA_USUARIOS" | "AGENTE_RUNTIME_ARN"

// Nomes e ARNs vêm de variáveis de ambiente definidas no CloudFormation: nada fixo no código.
export function configuracao(nome: Variavel): string {
    const valor = process.env[nome]
    if (!valor) throw new Error(`Variável de ambiente ${nome} não configurada`)
    return valor
}
