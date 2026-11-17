import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
const originalDb = DynamoDBDocumentClient.prototype.send;
const originalRuntime = BedrockAgentCoreClient.prototype.send;
let database: (command: any) => Promise<any> = async () => { throw new Error('Unexpected DB'); };
let agent: (command: any) => Promise<any> = async () => { throw new Error('Unexpected runtime'); };
DynamoDBDocumentClient.prototype.send = (async (command: any) => database(command)) as any;
BedrockAgentCoreClient.prototype.send = (async (command: any) => agent(command)) as any;
(globalThis as any).awslambda = { streamifyResponse: (fn: any) => fn,
  HttpResponseStream: { from: (stream: any, metadata: any) => { stream.metadata = metadata; return stream; } } };
process.env.CONVERSATIONS_TABLE = 'conversas';
const { handler, history } = await import('../src/chat-lambda.ts');
after(() => { DynamoDBDocumentClient.prototype.send = originalDb; BedrockAgentCoreClient.prototype.send = originalRuntime; });
const conversationId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const event = (body: any, sub: string | null = 'owner') => ({ requestContext: { authorizer: { claims: { sub } } }, body: JSON.stringify({ requestId, conversationId, ...body }) });
async function execute(input: any) {
  const stream: any = { metadata: null, chunks: [] as string[], writableEnded: false,
    write(value: string) { assert.equal(this.writableEnded, false); this.chunks.push(value); },
    end() { this.writableEnded = true; } };
  await handler(input, stream); return { status: stream.metadata.statusCode, events: stream.chunks.flatMap((s: string) => s.trim().split('\n').map(v => JSON.parse(v))) };
}
test('sem claims, identidade do corpo não autoriza chat nem histórico', async () => {
  const result = await execute(event({ message: 'oi', usuario_id: 'owner' }, null));
  assert.equal(result.status, 401); assert.equal(result.events[0].type, 'error');
  assert.equal((await history(event({}, null))).statusCode, 401);
});
test('conversa alheia não é acessível e usa chave do titular autenticado', async () => {
  database = async command => { assert.ok(command instanceof GetCommand); assert.equal(command.input.Key?.userId, 'owner'); return {}; };
  assert.equal((await execute(event({ message: 'oi', userId: 'victim' }))).status, 404);
});
test('confirmação divergente é rejeitada antes de invocar o agente', async () => {
  database = async () => ({ Item: { messages: [], version: 0, pending: { intencao_id: 'int1', metodo_pagamento: 'pix' } } });
  assert.equal((await execute(event({ confirmation: { intencao_id: 'int2', metodo_pagamento: 'pix' } }))).status, 400);
});
test('histórico completo é enviado e salvo com condição de dono/versão', async () => {
  const previous = [{ role: 'user', content: [{ text: 'Anterior' }] }, { role: 'assistant', content: [{ text: 'Resposta anterior' }] }];
  const writes: any[] = [];
  database = async command => {
    if (command instanceof GetCommand) return { Item: { messages: structuredClone(previous), version: 3 } };
    assert.ok(command instanceof UpdateCommand); writes.push(command.input); return {};
  };
  agent = async command => {
    const input = JSON.parse(Buffer.from(command.input.payload).toString());
    assert.equal(input.userId, 'owner'); assert.equal(input.messages.length, 3);
    assert.equal(input.messages[0].content[0].text, 'Anterior');
    return { response: (async function* () { yield Buffer.from(JSON.stringify({ type: 'done', messages: [...input.messages, { role: 'assistant', content: [{ text: 'Nova resposta' }] }], pending: null }) + '\n'); })() };
  };
  const result = await execute(event({ message: 'Nova mensagem', userId: 'victim' }));
  assert.equal(result.status, 200); assert.ok(result.events.some((e: any) => e.type === 'done'));
  assert.match(writes.at(-1).ConditionExpression, /lockOwner/);
  assert.equal(writes.at(-1).ExpressionAttributeValues[':version'], 3);
  assert.equal(writes.at(-1).ExpressionAttributeValues[':next'], 4);
  assert.equal(writes.at(-1).ExpressionAttributeValues[':messages'].length, 4);
});
