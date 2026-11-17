import { randomUUID, createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import type { Message } from '@aws-sdk/client-bedrock-runtime';
import type { Confirmation } from './engine.ts';

declare const awslambda: { streamifyResponse: (handler: (event: any, stream: any) => Promise<void>) => any;
  HttpResponseStream: { from: (stream: any, metadata: unknown) => any } };
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const runtime = new BedrockAgentCoreClient({ maxAttempts: 1 });
const table = process.env.CONVERSATIONS_TABLE!;
const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': process.env.FRONTEND_ORIGIN!, Vary: 'Origin' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function user(event: any): string | null {
  const sub = event.requestContext?.authorizer?.claims?.sub;
  return typeof sub === 'string' && sub.trim() && sub === sub.trim() ? sub : null;
}
function display(messages: Message[]) {
  return messages.flatMap(message => {
    const text = message.content?.flatMap(b => b.text ? [b.text] : []).join('') ?? '';
    return text ? [{ role: message.role, text }] : [];
  });
}
export async function history(event: any) {
  const userId = user(event);
  const reply = (statusCode: number, body: unknown) => ({ statusCode, headers, body: JSON.stringify(body) });
  if (!userId) return reply(401, { message: 'Autenticação necessária.' });
  const id = event.queryStringParameters?.conversationId;
  if (id) {
    if (!uuid.test(id)) return reply(400, { message: 'Conversa inválida.' });
    const { Item } = await db.send(new GetCommand({ TableName: table, Key: { userId, conversationId: id }, ConsistentRead: true }));
    if (!Item) return reply(404, { message: 'Conversa indisponível.' });
    return reply(200, { conversationId: id, messages: display(Item.messages ?? []), pending: Item.pending ?? null, busy: Item.lockUntil > Date.now() });
  }
  const { Items } = await db.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'userId = :user',
    ExpressionAttributeValues: { ':user': userId }, ProjectionExpression: 'conversationId, title, updatedAt', Limit: 100, ConsistentRead: true }));
  return reply(200, { conversations: (Items ?? []).sort((a, b) => b.updatedAt - a.updatedAt) });
}

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  let stream = responseStream;
  let started = false;
  const start = (statusCode: number) => {
    if (!started) { stream = awslambda.HttpResponseStream.from(responseStream, { statusCode, headers: { ...headers, 'Content-Type': 'application/x-ndjson' } }); started = true; }
  };
  const emit = (value: unknown) => { start(200); stream.write(JSON.stringify(value) + '\n'); };
  const reject = (code: number, message: string) => { start(code); stream.write(JSON.stringify({ type: 'error', message }) + '\n'); stream.end(); };
  const userId = user(event);
  if (!userId) { reject(401, 'Autenticação necessária.'); return; }
  let body: any;
  try {
    if (event.isBase64Encoded || !event.body || Buffer.byteLength(event.body) > 8192) throw new Error();
    body = JSON.parse(event.body);
    if (!body || typeof body !== 'object' || !uuid.test(body.requestId ?? '')) throw new Error();
    if (body.conversationId && !uuid.test(body.conversationId)) throw new Error();
    if (!body.confirmation && (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 4000)) throw new Error();
  } catch { reject(400, 'Mensagem ou identificador inválido.'); return; }
  const conversationId = body.conversationId || randomUUID();
  const Key = { userId, conversationId };
  let locked = false;
  let messages: Message[] = [];
  let pending: Confirmation | null = null;
  let version = 0;
  const save = async (release: boolean) => {
    if (Buffer.byteLength(JSON.stringify(messages)) > 300000) throw new Error('Histórico muito grande.');
    await db.send(new UpdateCommand({ TableName: table, Key,
      UpdateExpression: release ? 'SET messages = :messages, pending = :pending, updatedAt = :now, version = :next REMOVE lockUntil, lockOwner'
        : 'SET messages = :messages, pending = :pending, updatedAt = :now',
      ConditionExpression: 'lockOwner = :owner AND version = :version',
      ExpressionAttributeValues: { ':messages': messages, ':pending': pending, ':now': Date.now(), ':owner': body.requestId, ':version': version, ...(release ? { ':next': version + 1 } : {}) } }));
    if (release) locked = false;
  };
  try {
    const { Item: existing } = await db.send(new GetCommand({ TableName: table, Key, ConsistentRead: true }));
    if (!existing && body.conversationId) { reject(404, 'Conversa indisponível.'); return; }
    let row = existing;
    if (!row) {
      row = { ...Key, messages: [], pending: null, version: 0, title: String(body.message ?? 'Compra simulada').slice(0, 80), updatedAt: Date.now() };
      await db.send(new PutCommand({ TableName: table, Item: row, ConditionExpression: 'attribute_not_exists(userId)' }));
    }
    messages = row.messages ?? [];
    version = row.version ?? 0;
    if (messages.length > 120 || Buffer.byteLength(JSON.stringify(messages)) > 240000) { reject(400, 'Esta conversa atingiu o limite. Inicie uma nova conversa.'); return; }
    let confirmation: Confirmation | undefined;
    if (body.confirmation) {
      if (!row.pending || body.confirmation.intencao_id !== row.pending.intencao_id || body.confirmation.metodo_pagamento !== row.pending.metodo_pagamento) {
        reject(400, 'Confirmação inválida ou já utilizada. Atualize a conversa.'); return;
      }
      confirmation = row.pending;
    }
    const now = Date.now();
    await db.send(new UpdateCommand({ TableName: table, Key,
      UpdateExpression: 'SET lockUntil = :until, lockOwner = :owner, lastRequestId = :owner, pending = :empty',
      ConditionExpression: 'version = :version AND (attribute_not_exists(lockUntil) OR lockUntil < :now) AND (attribute_not_exists(lastRequestId) OR lastRequestId <> :owner)',
      ExpressionAttributeValues: { ':version': version, ':now': now, ':until': now + 180000, ':owner': body.requestId, ':empty': null } }));
    locked = true;
    const prompt = confirmation ? `Confirmo no botão a compra de ${confirmation.quantidade} × ${confirmation.produto_id}, total R$ ${confirmation.valor_total.toFixed(2)}, por ${confirmation.metodo_pagamento}.` : body.message.trim();
    messages.push({ role: 'user', content: [{ text: prompt }] });
    await save(false);
    emit({ type: 'start', conversationId });
    emit({ type: 'status', message: 'Conectando ao assistente…' });
    const heartbeat = setInterval(() => emit({ type: 'heartbeat' }), 10000);
    let completed = false;
    try {
      const result = await runtime.send(new InvokeAgentRuntimeCommand({ agentRuntimeArn: process.env.AGENT_RUNTIME_ARN,
        runtimeSessionId: createHash('sha256').update(`${userId}:${conversationId}`).digest('hex'),
        contentType: 'application/json', accept: 'application/x-ndjson',
        payload: Buffer.from(JSON.stringify({ userId, messages, ...(confirmation ? { confirmation } : {}) })) }), { abortSignal: AbortSignal.timeout(110000) });
      if (!result.response) throw new Error('Sem resposta do agente.');
      const decoder = new TextDecoder(); let buffer = '';
      for await (const chunk of result.response as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        if (buffer.length > 350000) throw new Error('Resposta excessiva.');
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          const item = JSON.parse(line);
          if (item.type === 'error') throw new Error(item.code === 'MODEL_ACCESS_PENDING' ? 'MODEL_ACCESS_PENDING' : 'Agente não concluiu.');
          if (item.type === 'checkpoint' || item.type === 'done') {
            messages = item.messages; pending = item.pending ?? null;
            await save(item.type === 'done');
            if (item.type === 'done') { completed = true; emit({ type: 'done', conversationId, pending }); }
          } else if (['delta', 'status', 'payment'].includes(item.type)) emit(item);
        }
      }
      if (!completed) throw new Error('Resposta incompleta.');
    } finally { clearInterval(heartbeat); }
  } catch (error) {
    if (!locked && !started && error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      reject(409, 'Conversa ocupada ou solicitação já recebida. Consulte o histórico.'); return;
    }
    if (locked) {
      messages.push({ role: 'assistant', content: [{ text: 'A operação não foi concluída. Consulte o estado da compra antes de repetir o pagamento.' }] });
      pending = null;
      try { await save(true); } catch { /* Lease expires; do not overwrite another request. */ }
    }
    emit({ type: 'error', message: error instanceof Error && error.message === 'MODEL_ACCESS_PENDING'
      ? 'O assistente aguarda liberação do serviço. Você pode usar o formulário de compras abaixo.'
      : 'Não foi possível concluir. Consulte compras e histórico antes de repetir.' });
    console.error('Falha no chat', { errorType: error instanceof Error ? error.name : 'Unknown' });
  } finally { if (!stream.writableEnded) stream.end(); }
});
