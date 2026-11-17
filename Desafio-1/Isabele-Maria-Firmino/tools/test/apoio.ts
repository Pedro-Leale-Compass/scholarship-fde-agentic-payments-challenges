import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb'
import { BatchWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createDocClient } from '../src/shared/dynamo.ts'
import type { Produto } from '../src/shared/produtos.ts'
import type { Tabelas } from '../src/create-compra.ts'

export type AmbienteTeste = {
  db: DynamoDBDocumentClient
  tabelas: Tabelas
  deleteAmbienteTeste: () => Promise<void>
}

const CHAVES: Record<keyof Tabelas, string> = {
  usuarios: 'usuario_id',
  catalogo: 'produto_id',
  intencoes: 'intencao_id',
  transacoes: 'transacao_id',
}

const ENDPOINT_LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/

export function readProdutos(): Produto[] {
  const caminho = new URL('../../infra/seed/produtos.json', import.meta.url)
  return JSON.parse(readFileSync(caminho, 'utf8')) as Produto[]
}

export async function seedCatalogo(db: DynamoDBDocumentClient, tabela: string, produtos: Produto[]): Promise<void> {
  await db.send(
    new BatchWriteCommand({
      RequestItems: { [tabela]: produtos.map((produto) => ({ PutRequest: { Item: produto } })) },
    }),
  )
}

export async function createAmbienteTeste(): Promise<AmbienteTeste> {
  const endpoint = process.env.DYNAMODB_ENDPOINT ?? ''
  if (!ENDPOINT_LOCAL.test(endpoint)) {
    throw new Error('DYNAMODB_ENDPOINT precisa apontar para o DynamoDB Local (http://localhost:8000). Rode com npm test.')
  }

  const db = createDocClient(endpoint)
  const sufixo = randomUUID().slice(0, 8)
  const tipos = Object.keys(CHAVES) as (keyof Tabelas)[]
  const tabelas: Tabelas = {
    usuarios: `teste-${sufixo}-usuarios`,
    catalogo: `teste-${sufixo}-catalogo`,
    intencoes: `teste-${sufixo}-intencoes`,
    transacoes: `teste-${sufixo}-transacoes`,
  }

  await Promise.all(
    tipos.map((tipo) =>
      db.send(
        new CreateTableCommand({
          TableName: tabelas[tipo],
          AttributeDefinitions: [{ AttributeName: CHAVES[tipo], AttributeType: 'S' }],
          KeySchema: [{ AttributeName: CHAVES[tipo], KeyType: 'HASH' }],
          BillingMode: 'PAY_PER_REQUEST',
        }),
      ),
    ),
  )

  await seedCatalogo(db, tabelas.catalogo, readProdutos())

  return {
    db,
    tabelas,
    deleteAmbienteTeste: async () => {
      await Promise.all(tipos.map((tipo) => db.send(new DeleteTableCommand({ TableName: tabelas[tipo] }))))
      db.destroy()
    },
  }
}
