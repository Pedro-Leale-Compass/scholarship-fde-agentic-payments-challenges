import { randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import { CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createDocClient } from '../src/shared/dynamo.ts'
import type { OpenResposta } from '../src/stream-chat.ts'

export type AmbienteTeste = {
  db: DynamoDBDocumentClient
  tabelaConversas: string
  deleteAmbienteTeste: () => Promise<void>
}

export type RespostaFalsa = {
  open: OpenResposta
  getStatus: () => number | undefined
  getAberturas: () => number
  getEventos: () => Record<string, unknown>[]
  isFinalizada: () => boolean
}

const ENDPOINT_LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/

export async function createAmbienteTeste(): Promise<AmbienteTeste> {
  const endpoint = process.env.DYNAMODB_ENDPOINT ?? ''
  if (!ENDPOINT_LOCAL.test(endpoint)) {
    throw new Error('DYNAMODB_ENDPOINT precisa apontar para o DynamoDB Local (http://localhost:8000). Rode com npm test.')
  }

  const db = createDocClient(endpoint)
  const tabelaConversas = `teste-${randomUUID().slice(0, 8)}-conversas`

  await db.send(
    new CreateTableCommand({
      TableName: tabelaConversas,
      AttributeDefinitions: [
        { AttributeName: 'usuario_id', AttributeType: 'S' },
        { AttributeName: 'conversa_id', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'usuario_id', KeyType: 'HASH' },
        { AttributeName: 'conversa_id', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  )

  return {
    db,
    tabelaConversas,
    deleteAmbienteTeste: async () => {
      await db.send(new DeleteTableCommand({ TableName: tabelaConversas }))
      db.destroy()
    },
  }
}

export function createRespostaFalsa(): RespostaFalsa {
  const partes: Buffer[] = []
  let status: number | undefined
  let aberturas = 0

  const saida = new Writable({
    write(pedaco, _codificacao, concluir) {
      partes.push(Buffer.from(pedaco))
      concluir()
    },
  })

  return {
    open: (statusCode) => {
      aberturas += 1
      status = statusCode
      return saida
    },
    getStatus: () => status,
    getAberturas: () => aberturas,
    getEventos: () =>
      Buffer.concat(partes)
        .toString('utf8')
        .split('\n')
        .filter((linha) => linha.trim())
        .map((linha) => JSON.parse(linha) as Record<string, unknown>),
    isFinalizada: () => saida.writableFinished,
  }
}
