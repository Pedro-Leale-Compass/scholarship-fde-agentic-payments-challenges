import { mockClient } from "aws-sdk-client-mock"
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb"
import { afterEach, beforeEach } from "vitest"

// Nenhum teste fala com a AWS: o DocumentClient é substituído por um mock e
// qualquer comando sem resposta configurada devolve undefined.
export const ddbMock = mockClient(DynamoDBDocumentClient)

process.env.AWS_REGION = "us-east-1"
process.env.TABELA_USUARIOS = "t-usuarios"
process.env.TABELA_PRODUTOS = "t-produtos"
process.env.TABELA_INTENCOES = "t-intencoes"
process.env.TABELA_TRANSACOES = "t-transacoes"

beforeEach(() => {
    ddbMock.reset()
})

afterEach(() => {
    ddbMock.reset()
})

export const USUARIO = "aaaaaaaa-0000-0000-0000-000000000001"
export const OUTRO_USUARIO = "bbbbbbbb-0000-0000-0000-000000000002"
export const FONE = {
    produto_id: "10000000-0000-0000-0000-000000000001",
    nome: "Fone Bluetooth",
    preco_centavos: 24990,
    moeda: "BRL",
    estoque: 12,
    categoria: "audio",
}
export const TECLADO = {
    produto_id: "10000000-0000-0000-0000-000000000002",
    nome: "Teclado Mecânico",
    preco_centavos: 45900,
    moeda: "BRL",
    estoque: 5,
    categoria: "perifericos",
}
