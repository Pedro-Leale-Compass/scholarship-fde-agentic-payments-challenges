/// <reference types="aws-lambda" />
import { randomUUID } from 'node:crypto'
import type { Context } from 'aws-lambda'
import type { Writable } from 'node:stream'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore'

type ApiEvent = {
  body: string | null
  httpMethod: string
  pathParameters?: Record<string, string | undefined> | null
  requestContext: { authorizer?: { sub?: string; claims?: Record<string, string | undefined> } | null }
}
type StoredMessage = { role: 'user' | 'assistant'; content: unknown }
class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message) }
}

const tableName = process.env.CONVERSATIONS_TABLE_NAME
const runtimeArn = process.env.AGENT_RUNTIME_ARN
if (!tableName || !runtimeArn) throw new Error('CONVERSATIONS_TABLE_NAME e AGENT_RUNTIME_ARN são obrigatórios.')
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } })
const agentCore = new BedrockAgentCoreClient({ region: process.env.AWS_REGION ?? 'us-east-1' })
const key = (userId: string, sortKey: string) => ({ PK: 'USER#' + userId, SK: sortKey })
const conversationSk = (id: string) => 'CONVERSATION#' + id
const messagesPrefix = (id: string) => conversationSk(id) + '#MSG#'
const isConditional = (error: unknown) => error instanceof Error && error.name === 'ConditionalCheckFailedException'

function userIdFrom(event: ApiEvent) {
  const userId = event.requestContext.authorizer?.sub ?? event.requestContext.authorizer?.claims?.sub
  if (!userId) throw new HttpError(401, 'Não autorizado.')
  return userId
}
function conversationId(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, 'Identificador de conversa inválido.')
  }
  return value
}
function createStream(raw: Writable, statusCode: number, contentType = 'text/event-stream; charset=utf-8') {
  return awslambda.HttpResponseStream.from(raw, {
    statusCode,
    headers: { 'content-type': contentType, 'cache-control': 'no-cache, no-store', 'x-accel-buffering': 'no', 'access-control-allow-origin': process.env.FRONTEND_ORIGIN ?? '', 'vary': 'Origin' },
  })
}
function sendEvent(stream: Writable, name: string, data: unknown) {
  stream.write('event: ' + name + '\n')
  stream.write('data: ' + JSON.stringify(data) + '\n\n')
}
async function acquireConversation(userId: string, id: string, token: string) {
  const now = Date.now()
  try {
    await db.send(new UpdateCommand({
      TableName: tableName,
      Key: key(userId, conversationSk(id)),
      UpdateExpression: 'SET entity = if_not_exists(entity, :entity), createdAt = if_not_exists(createdAt, :now), updatedAt = :now, lockToken = :token, lockUntil = :until',
      ConditionExpression: 'attribute_not_exists(lockUntil) OR lockUntil < :now',
      ExpressionAttributeValues: { ':entity': 'Conversation', ':now': now, ':token': token, ':until': now + 16 * 60 * 1000 },
    }))
  } catch (error) {
    if (isConditional(error)) throw new HttpError(409, 'Esta conversa já está processando outra mensagem. Aguarde e tente novamente.')
    throw error
  }
}
async function releaseConversation(userId: string, id: string, token: string) {
  try {
    await db.send(new UpdateCommand({
      TableName: tableName,
      Key: key(userId, conversationSk(id)),
      UpdateExpression: 'REMOVE lockToken, lockUntil',
      ConditionExpression: 'lockToken = :token',
      ExpressionAttributeValues: { ':token': token },
    }))
  } catch (error) { if (!isConditional(error)) console.error('Falha ao liberar o bloqueio da conversa.', error) }
}
async function loadHistory(userId: string, id: string): Promise<StoredMessage[]> {
  const messages: StoredMessage[] = []
  let ExclusiveStartKey: Record<string, unknown> | undefined
  do {
    const page = await db.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': 'USER#' + userId, ':prefix': messagesPrefix(id) },
      ConsistentRead: true,
      ExclusiveStartKey,
    }))
    messages.push(...((page.Items ?? []).map((item) => item.message as StoredMessage)))
    ExclusiveStartKey = page.LastEvaluatedKey
  } while (ExclusiveStartKey)
  return messages
}
async function loadTranscript(userId: string, id: string): Promise<StoredMessage[]> {
  const messages: StoredMessage[] = []
  let ExclusiveStartKey: Record<string, unknown> | undefined
  do {
    const page = await db.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': 'USER#' + userId, ':prefix': conversationSk(id) + '#DISPLAY#' },
      ConsistentRead: true,
      ExclusiveStartKey,
    }))
    messages.push(...((page.Items ?? []).map((item) => item.message as StoredMessage)))
    ExclusiveStartKey = page.LastEvaluatedKey
  } while (ExclusiveStartKey)
  return messages
}

async function saveTurn(userId: string, id: string, token: string, firstSequence: number, messages: StoredMessage[], prompt: string, responseText: string, displaySequence: number) {
  if (messages.length > 97) throw new HttpError(502, 'A resposta excedeu o tamanho permitido para uma única atualização.')
  const now = new Date().toISOString()
  const transactions: NonNullable<TransactWriteCommandInput['TransactItems']> = messages.map((message, index) => ({
    Put: {
      TableName: tableName,
      Item: {
        ...key(userId, messagesPrefix(id) + String(firstSequence + index).padStart(8, '0')),
        entity: 'ConversationMessage',
        userId,
        conversationId: id,
        sequence: firstSequence + index,
        message,
        createdAt: now,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    },
  }))
  transactions.push(
    {
      Put: {
        TableName: tableName,
        Item: { ...key(userId, conversationSk(id) + '#DISPLAY#' + String(displaySequence).padStart(8, '0')), entity: 'DisplayMessage', userId, conversationId: id, sequence: displaySequence, message: { role: 'user', content: prompt }, createdAt: now },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    },
    {
      Put: {
        TableName: tableName,
        Item: { ...key(userId, conversationSk(id) + '#DISPLAY#' + String(displaySequence + 1).padStart(8, '0')), entity: 'DisplayMessage', userId, conversationId: id, sequence: displaySequence + 1, message: { role: 'assistant', content: responseText }, createdAt: now },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    },
  )
  transactions.push({
    Update: {
      TableName: tableName,
      Key: key(userId, conversationSk(id)),
      UpdateExpression: 'SET updatedAt = :now, version = if_not_exists(version, :zero) + :one REMOVE lockToken, lockUntil',
      ConditionExpression: 'lockToken = :token',
      ExpressionAttributeValues: { ':now': now, ':zero': 0, ':one': 1, ':token': token },
    },
  })
  try {
    await db.send(new TransactWriteCommand({ TransactItems: transactions }))
  } catch (error) {
    if (error instanceof Error && error.name === 'TransactionCanceledException') {
      throw new HttpError(409, 'Não foi possível salvar a conversa por conflito de atualização. Recarregue o histórico antes de continuar.')
    }
    throw error
  }
}

async function invokeAgent(userId: string, id: string, history: StoredMessage[], message: string) {
  const result = await agentCore.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: runtimeArn,
    runtimeSessionId: id,
    qualifier: 'DEFAULT',
    contentType: 'application/json',
    accept: 'application/json',
    payload: new TextEncoder().encode(JSON.stringify({ userId, conversationId: id, history, message })),
  }))
  const raw = await result.response?.transformToString()
  if (!raw) throw new Error('O agente não retornou conteúdo.')
  const payload = JSON.parse(raw) as { response?: unknown; messages?: unknown }
  if (typeof payload.response !== 'string' || !Array.isArray(payload.messages)) throw new Error('Resposta inválida do agente.')
  return payload as { response: string; messages: StoredMessage[] }
}

export const handler = awslambda.streamifyResponse(async (event: ApiEvent, rawStream: Writable, _context: Context) => {
  let stream: Writable | undefined
  let lock: { userId: string; id: string; token: string } | undefined
  try {
    const userId = userIdFrom(event)
    if (event.httpMethod === 'GET') {
      const id = conversationId(event.pathParameters?.conversationId)
      const meta = await db.send(new GetCommand({ TableName: tableName, Key: key(userId, conversationSk(id)), ConsistentRead: true }))
      if (!meta.Item) throw new HttpError(404, 'Conversa não encontrada.')
      const transcript = await loadTranscript(userId, id)
      stream = createStream(rawStream, 200, 'application/json; charset=utf-8')
      stream.write(JSON.stringify({ conversationId: id, messages: transcript }))
      return
    }
    if (event.httpMethod !== 'POST') throw new HttpError(404, 'Rota não encontrada.')
    if (!event.body) throw new HttpError(400, 'Envie uma mensagem.')
    let body: { message?: unknown; conversationId?: unknown }
    try { body = JSON.parse(event.body) } catch { throw new HttpError(400, 'Corpo da requisição inválido.') }
    if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 8000) {
      throw new HttpError(400, 'A mensagem deve conter de 1 a 8000 caracteres.')
    }
    const id = body.conversationId === undefined || body.conversationId === null ? randomUUID() : conversationId(body.conversationId)
    const token = randomUUID()
    await acquireConversation(userId, id, token)
    lock = { userId, id, token }
    const history = await loadHistory(userId, id)
    const transcript = await loadTranscript(userId, id)
    stream = createStream(rawStream, 200)
    sendEvent(stream, 'status', { status: 'processing', conversationId: id })
    const agentResult = await invokeAgent(userId, id, history, body.message)
    if (agentResult.messages.length < history.length) throw new Error('O agente retornou histórico incompleto.')
    const additions = agentResult.messages.slice(history.length)
    const safeMessages = JSON.parse(JSON.stringify(additions)) as StoredMessage[]
    if (safeMessages.some((item) => !item || (item.role !== 'user' && item.role !== 'assistant'))) {
      throw new Error('O agente retornou mensagens inválidas.')
    }
    await saveTurn(userId, id, token, history.length, safeMessages, body.message, agentResult.response, transcript.length)
    lock = undefined
    sendEvent(stream, 'message', { conversationId: id, response: agentResult.response })
    sendEvent(stream, 'done', { conversationId: id })
  } catch (error) {
    console.error('Falha ao processar a requisição do chat.', error)
    const status = error instanceof HttpError ? error.statusCode : 502
    if (!stream) stream = createStream(rawStream, status)
    sendEvent(stream, 'error', { message: error instanceof HttpError ? error.message : 'Não foi possível responder agora. Tente novamente.' })
  } finally {
    if (lock) await releaseConversation(lock.userId, lock.id, lock.token)
    stream?.end()
  }
});







