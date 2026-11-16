import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'

export function createDocClient(endpoint = process.env.DYNAMODB_ENDPOINT): DynamoDBDocumentClient {
  const client = endpoint
    ? new DynamoDBClient({
        endpoint,
        region: 'us-east-1',
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      })
    : new DynamoDBClient({})
  return DynamoDBDocumentClient.from(client)
}

export function requireEnv(nome: string): string {
  const valor = process.env[nome]?.trim()
  if (!valor) throw new Error(`variável de ambiente ${nome} não configurada`)
  return valor
}

export const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailedException'

export function getNomeErro(erro: unknown): string | undefined {
  return erro instanceof Error ? erro.name : undefined
}
