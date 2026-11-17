import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { fromIni } from '@aws-sdk/credential-providers';
import { DynamoPaymentStore } from '../src/dynamo-store.ts';
import { createPaymentTools } from '../src/payments.ts';

const expected = process.argv[process.argv.indexOf('--account') + 1];
if (!process.argv.includes('--account') || !/^\d{12}$/.test(expected)) throw new Error('Informe --account CONTA_ESPERADA.');
const profile = 'desafio-1';
const identity = JSON.parse(execFileSync('aws', ['sts', 'get-caller-identity', '--profile', profile, '--output', 'json'], { encoding: 'utf8' }));
assert.equal(identity.Account, expected, 'Conta AWS incorreta.');
assert.match(identity.Arn, /assumed-role\/AWSReservedSSO_/);
const tables = { users: 'paulo-antonio-pagamentos-usuarios', intents: 'paulo-antonio-pagamentos-intencoes', transactions: 'paulo-antonio-pagamentos-transacoes' };
const clients: DynamoDBClient[] = [];
function client() {
  const raw = new DynamoDBClient({ region: 'us-east-1', credentials: fromIni({ profile }), maxAttempts: 3 });
  clients.push(raw);
  return DynamoDBDocumentClient.from(raw);
}
const db = client();
const runId = `integration-${randomUUID()}`;
const users: string[] = [];
const intents: string[] = [];
let checks = 0;
const get = async (TableName: string, Key: Record<string, string>) => (await db.send(new GetCommand({ TableName, Key, ConsistentRead: true }))).Item;
async function fixture(limit = 500000) {
  const context = { usuario_id: `${runId}-${users.length}` };
  users.push(context.usuario_id);
  const store = new DynamoPaymentStore(db, tables);
  await store.ensureUser(context.usuario_id, limit);
  const tools = createPaymentTools(store);
  const intent = async (sku = 'MONITOR', quantidade = 1) => {
    const item = await tools.registrar_intencao({ sku, quantidade }, context);
    intents.push(item.intencao_id);
    return item;
  };
  const buy = (id: string, method: unknown = 'pix') => tools.realizar_compra({ intencao_id: id, metodo_pagamento: method }, context);
  return { context, store, tools, intent, buy };
}
const ok = (message: string) => { checks++; console.log(`OK: ${message}`); };
async function completeAll<T>(promises: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  const failed = results.find(r => r.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return results.map(r => (r as PromiseFulfilledResult<T>).value);
}
try {
  const first = await fixture();
  const item = await first.intent();
  // New SDK client/store: no process-local Maps can supply the intent or balance.
  const restarted = createPaymentTools(new DynamoPaymentStore(client(), tables));
  const result = await restarted.realizar_compra({ intencao_id: item.intencao_id, metodo_pagamento: 'pix' }, first.context);
  assert.equal(result.status, 'aprovado');
  if (result.status !== 'aprovado') throw new Error('Compra não aprovada');
  assert.equal(result.limite_restante, 3100.1);
  assert.equal((await get(tables.users, { userId: first.context.usuario_id }))?.spent, 189990);
  assert.equal((await get(tables.intents, { id: item.intencao_id }))?.status, 'paga');
  assert.equal((await get(tables.transactions, { id: result.transacao_id }))?.result.valor, 1899.9);
  ok('estado persistido acessível por outro cliente; débito, intenção e transação consistentes');
  await first.store.ensureUser(first.context.usuario_id, 3000000);
  const original = await get(tables.users, { userId: first.context.usuario_id });
  assert.equal(original?.limit, 500000); assert.equal(original?.spent, 189990);
  ok('provisionamento repetido não restaura saldo nem aumenta limite');
  assert.equal((await first.buy(item.intencao_id) as { erro: string }).erro, 'INTENCAO_JA_PAGA');
  ok('repetição recusa sem segundo débito');

  const other = await fixture();
  const pending = await first.intent('CADEIRA');
  assert.equal((await other.buy(pending.intencao_id) as { erro: string }).erro, 'INTENCAO_INVALIDA');
  assert.equal((await first.buy(pending.intencao_id, 'boleto') as { erro: string }).erro, 'METODO_INVALIDO');
  assert.equal((await get(tables.intents, { id: pending.intencao_id }))?.status, 'pendente');
  assert.equal(await get(tables.transactions, { id: `tx_${pending.intencao_id}` }), undefined);
  ok('titularidade e método inválido preservam estado');
  assert.equal((await first.buy(pending.intencao_id, 'cartao')).status, 'aprovado');
  ok('cartão aprovado');

  const expiredId = `int_${randomUUID()}`;
  intents.push(expiredId);
  await other.store.saveIntent({ id: expiredId, userId: other.context.usuario_id, sku: 'PS5', quantity: 1, cents: 479900, expiresAt: Date.now() - 1, status: 'pendente' });
  assert.equal((await other.buy(expiredId) as { erro: string }).erro, 'INTENCAO_EXPIRADA');
  assert.equal((await get(tables.users, { userId: other.context.usuario_id }))?.spent, 0);
  ok('intenção expirada não debita');

  const race = await fixture();
  const raceIntent = await race.intent('PS5');
  const raceResults = await completeAll(Array.from({ length: 5 }, () => race.buy(raceIntent.intencao_id)));
  assert.equal(raceResults.filter(r => r.status === 'aprovado').length, 1);
  assert.ok(raceResults.filter(r => r.status === 'recusado').every(r => r.erro === 'INTENCAO_JA_PAGA'));
  assert.equal((await get(tables.users, { userId: race.context.usuario_id }))?.spent, 479900);
  ok('cinco chamadas simultâneas da mesma intenção: exatamente um débito');

  const balance = await fixture(379980);
  const batch = await completeAll(Array.from({ length: 3 }, () => balance.intent()));
  const results = await completeAll(batch.map(i => balance.buy(i.intencao_id)));
  assert.equal(results.filter(r => r.status === 'aprovado').length, 2);
  assert.equal((results.find(r => r.status === 'recusado') as { erro: string }).erro, 'LIMITE_EXCEDIDO');
  assert.equal((await get(tables.users, { userId: balance.context.usuario_id }))?.spent, 379980);
  for (let i = 0; i < batch.length; i++) {
    const transaction = await get(tables.transactions, { id: `tx_${batch[i].intencao_id}` });
    assert.equal(Boolean(transaction), results[i].status === 'aprovado');
  }
  ok('intenções concorrentes respeitam saldo exato e não deixam transação parcial');
} finally {
  // Only exact IDs generated in this run; no scan, truncate, or real-user deletion.
  try {
    for (const id of intents) {
      await db.send(new DeleteCommand({ TableName: tables.transactions, Key: { id: `tx_${id}` } }));
      await db.send(new DeleteCommand({ TableName: tables.intents, Key: { id } }));
    }
    for (const userId of users) await db.send(new DeleteCommand({ TableName: tables.users, Key: { userId } }));
    console.log('Dados fictícios desta execução removidos.');
  } finally { clients.forEach(c => c.destroy()); }
}
console.log(`${checks} verificações de integração passaram no DynamoDB real.`);
