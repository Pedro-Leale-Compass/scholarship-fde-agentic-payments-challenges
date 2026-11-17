import { GetCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { CONDITIONAL_CHECK_FAILED, getNomeErro } from './dynamo.ts'

export type Mensagem = {
  role: 'user' | 'assistant'
  content: Record<string, unknown>[]
  [campo: string]: unknown
}

export type Conversa = {
  usuario_id: string
  conversa_id: string
  titulo: string
  mensagens: Mensagem[]
  total_mensagens: number
  criada_em: string
  atualizada_em: string
}

export type ResumoConversa = Pick<Conversa, 'conversa_id' | 'titulo' | 'criada_em' | 'atualizada_em'>

export class ConversaConcorrente extends Error {
  override name = 'ConversaConcorrente'
}

export const TAMANHO_TITULO = 60

export function createTitulo(texto: string): string {
  const limpo = texto.replace(/\s+/g, ' ').trim()
  return limpo.length > TAMANHO_TITULO ? `${limpo.slice(0, TAMANHO_TITULO - 1)}…` : limpo
}

export async function getConversa(
  db: DynamoDBDocumentClient,
  tabela: string,
  usuarioId: string,
  conversaId: string,
): Promise<Conversa | undefined> {
  const { Item } = await db.send(
    new GetCommand({
      TableName: tabela,
      Key: { usuario_id: usuarioId, conversa_id: conversaId },
      ConsistentRead: true,
    }),
  )
  return Item as Conversa | undefined
}

export async function listConversas(
  db: DynamoDBDocumentClient,
  tabela: string,
  usuarioId: string,
): Promise<ResumoConversa[]> {
  const conversas: ResumoConversa[] = []
  let inicio: Record<string, unknown> | undefined
  do {
    const resultado = await db.send(
      new QueryCommand({
        TableName: tabela,
        KeyConditionExpression: 'usuario_id = :usuario',
        ProjectionExpression: 'conversa_id, titulo, criada_em, atualizada_em',
        ExpressionAttributeValues: { ':usuario': usuarioId },
        ExclusiveStartKey: inicio,
      }),
    )
    conversas.push(...((resultado.Items ?? []) as ResumoConversa[]))
    inicio = resultado.LastEvaluatedKey
  } while (inicio)

  return conversas.sort((a, b) => b.atualizada_em.localeCompare(a.atualizada_em))
}

export async function appendMensagens(
  db: DynamoDBDocumentClient,
  tabela: string,
  turno: {
    usuarioId: string
    conversaId: string
    totalAnterior: number
    titulo: string
    novas: Mensagem[]
  },
  agora = new Date(),
): Promise<void> {
  const conversaNova = turno.totalAnterior === 0
  const valores: Record<string, unknown> = {
    ':vazia': [],
    ':novas': turno.novas,
    ':total': turno.totalAnterior + turno.novas.length,
    ':agora': agora.toISOString(),
    ':titulo': turno.titulo,
  }
  if (!conversaNova) valores[':anterior'] = turno.totalAnterior

  try {
    await db.send(
      new UpdateCommand({
        TableName: tabela,
        Key: { usuario_id: turno.usuarioId, conversa_id: turno.conversaId },
        UpdateExpression:
          'SET mensagens = list_append(if_not_exists(mensagens, :vazia), :novas), ' +
          'total_mensagens = :total, atualizada_em = :agora, ' +
          'criada_em = if_not_exists(criada_em, :agora), titulo = if_not_exists(titulo, :titulo)',
        ConditionExpression: conversaNova ? 'attribute_not_exists(usuario_id)' : 'total_mensagens = :anterior',
        ExpressionAttributeValues: valores,
      }),
    )
  } catch (erro) {
    if (getNomeErro(erro) === CONDITIONAL_CHECK_FAILED) {
      throw new ConversaConcorrente('a conversa foi alterada por outro turno')
    }
    throw erro
  }
}
