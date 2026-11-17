import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { LambdaClient, InvokeCommand, InvokeWithResponseStreamCommand } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const account = process.argv[process.argv.indexOf('--account') + 1];
assert.ok(process.argv.includes('--account') && /^\d{12}$/.test(account), 'Informe --account CONTA');
process.env.AWS_PROFILE = 'desafio-1'; process.env.AWS_REGION = 'us-east-1';
const identity = JSON.parse(execFileSync('aws', ['sts', 'get-caller-identity', '--profile', 'desafio-1', '--output', 'json'], { encoding: 'utf8' }));
assert.equal(identity.Account, account); assert.match(identity.Arn, /assumed-role\/AWSReservedSSO_/);
const lambda = new LambdaClient({ region: 'us-east-1', maxAttempts: 1 });
const raw = new DynamoDBClient({ region: 'us-east-1' }); const db = DynamoDBDocumentClient.from(raw);
const userId = `integration-chat-${randomUUID()}`;
const table = 'paulo-antonio-pagamentos-conversas';
let conversationId = ''; const intents = new Set<string>();
const claims = (sub: string | null) => ({ authorizer: { claims: { sub } } });
async function history(sub: string | null, id?: string) {
  const response = await lambda.send(new InvokeCommand({ FunctionName: 'paulo-antonio-pagamentos-historico',
    Payload: Buffer.from(JSON.stringify({ requestContext: claims(sub), queryStringParameters: id ? { conversationId: id } : null })) }));
  assert.equal(response.FunctionError, undefined);
  const value = JSON.parse(Buffer.from(response.Payload!).toString()); return { status: value.statusCode, body: JSON.parse(value.body) };
}
async function chat(body: object, sub: string | null = userId) {
  // Administrative Lambda invocation with a fixture authorizer, NOT a positive Cognito test.
  const result = await lambda.send(new InvokeWithResponseStreamCommand({ FunctionName: 'paulo-antonio-pagamentos-chat',
    Payload: Buffer.from(JSON.stringify({ requestContext: claims(sub), body: JSON.stringify({ requestId: randomUUID(), ...body }) })) }));
  const chunks: Uint8Array[] = []; let parts = 0;
  for await (const event of result.EventStream ?? []) {
    if (event.PayloadChunk?.Payload) { chunks.push(event.PayloadChunk.Payload); parts++; }
    if (event.InvokeComplete) assert.equal(event.InvokeComplete.ErrorCode, undefined, event.InvokeComplete.ErrorDetails);
  }
  const bytes = Buffer.concat(chunks); const delimiter = bytes.indexOf(Buffer.alloc(8));
  assert.ok(delimiter >= 0, 'Metadados HTTP do streaming ausentes');
  const meta = JSON.parse(bytes.subarray(0, delimiter).toString());
  const events = bytes.subarray(delimiter + 8).toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const start = events.find(e => e.type === 'start'); if (start) conversationId = start.conversationId;
  const done = events.find(e => e.type === 'done'); if (done?.pending) intents.add(done.pending.intencao_id);
  return { meta, events, parts, done };
}
try {
  assert.equal((await history(null)).status, 401);
  assert.equal((await chat({ message: 'oi' }, null)).meta.statusCode, 401);
  const first = await chat({ message: 'Consulte o catálogo e meu limite. Quero comprar exatamente 1 MONITOR por pix. Prepare a intenção e solicite a confirmação no botão. Não efetue pagamento ainda.' });
  assert.equal(first.meta.statusCode, 200);
  if (process.argv.includes('--expect-unavailable')) {
    assert.match(first.events.find(e => e.type === 'error')?.message ?? '', /aguarda liberação/);
    assert.equal(first.done, undefined);
    assert.equal((await history(`${userId}-other`, conversationId)).status, 404);
    assert.equal((await history(userId, conversationId)).body.messages.length, 2);
    assert.equal((await history(userId)).body.conversations.length, 1);
    const record = await db.send(new GetCommand({ TableName: table, Key: { userId, conversationId }, ConsistentRead: true }));
    assert.equal(record.Item?.lockOwner, undefined);
    assert.equal(record.Item?.pending, null);
    console.log('OK: indisponibilidade do modelo tratada; histórico salvo, isolamento e lease liberado. Conversa com o modelo NÃO validada.');
  } else {
  assert.ok(first.done, JSON.stringify(first.events));
  assert.ok(first.done.pending, 'O modelo não preparou a confirmação esperada.');
  assert.ok(first.parts > 1, 'Esperados múltiplos blocos de resposta.');
  const pending = first.done.pending;
  assert.equal(pending.valor_total, 1899.9);
  assert.equal((await history(`${userId}-other`, conversationId)).status, 404);
  const before = await db.send(new GetCommand({ TableName: 'paulo-antonio-pagamentos-usuarios', Key: { userId }, ConsistentRead: true }));
  assert.equal(before.Item?.spent, 0, 'Preparar intenção não pode debitar');
  const saved = await history(userId, conversationId); assert.equal(saved.status, 200); assert.ok(saved.body.messages.length >= 2);
  assert.equal((await history(userId)).body.conversations.length, 1);
  const spoofed = await chat({ conversationId, confirmation: { ...pending, intencao_id: 'outro' } });
  assert.equal(spoofed.meta.statusCode, 400);
  const confirmed = await chat({ conversationId, confirmation: pending });
  assert.ok(confirmed.done, JSON.stringify(confirmed.events));
  assert.equal(confirmed.events.find(e => e.type === 'payment')?.result.status, 'aprovado');
  const duplicate = await chat({ conversationId, confirmation: pending });
  assert.equal(duplicate.meta.statusCode, 400);
  const after = await db.send(new GetCommand({ TableName: 'paulo-antonio-pagamentos-usuarios', Key: { userId }, ConsistentRead: true }));
  assert.equal(after.Item?.spent, 189990, 'Exatamente um débito em centavos');
  const record = await db.send(new GetCommand({ TableName: table, Key: { userId, conversationId }, ConsistentRead: true }));
  assert.ok(record.Item?.messages.some((m: any) => m.content?.some((c: any) => c.toolResult)), 'Histórico deve preservar resultados de ferramentas');
  console.log('OK: streaming Lambda → AgentCore → Haiku → ferramentas; confirmação, compra única, histórico completo e isolamento. Autorizador positivo não testado por este script.');
  }
} finally {
  // Discover only this fixture's own persisted tool results; never scan other users.
  if (conversationId) {
    const { Item } = await db.send(new GetCommand({ TableName: table, Key: { userId, conversationId }, ConsistentRead: true }));
    for (const message of Item?.messages ?? []) for (const block of message.content ?? []) {
      for (const result of block.toolResult?.content ?? []) if (result.json?.intencao_id) intents.add(result.json.intencao_id);
    }
    await db.send(new DeleteCommand({ TableName: table, Key: { userId, conversationId } }));
  }
  for (const id of intents) {
    await db.send(new DeleteCommand({ TableName: 'paulo-antonio-pagamentos-intencoes', Key: { id } }));
    await db.send(new DeleteCommand({ TableName: 'paulo-antonio-pagamentos-transacoes', Key: { id: `tx_${id}` } }));
  }
  await db.send(new DeleteCommand({ TableName: 'paulo-antonio-pagamentos-usuarios', Key: { userId } }));
  lambda.destroy(); raw.destroy(); console.log('Fixtures removidas.');
}
