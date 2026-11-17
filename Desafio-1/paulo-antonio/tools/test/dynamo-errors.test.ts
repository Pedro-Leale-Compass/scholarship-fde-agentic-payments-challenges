import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoPaymentStore } from '../src/dynamo-store.ts';

const tables = { users: 'users', intents: 'intents', transactions: 'transactions' };
function fake(ambiguousCommit: boolean) {
  let saved: Record<string, unknown> | undefined;
  const original = Object.assign(new Error('Falha de infraestrutura'), { name: ambiguousCommit ? 'TimeoutError' : 'AccessDeniedException' });
  const client = { async send(command: any) {
    if (command instanceof TransactWriteCommand) {
      if (ambiguousCommit) saved = command.input.TransactItems![2].Put!.Item;
      throw original;
    }
    if (command.input.TableName === 'users') return { Item: { userId: 'alice', limit: 500000, spent: 0 } };
    if (command.input.TableName === 'intents') return { Item: { id: 'int_1', userId: 'alice', cents: 189990, status: 'pendente', expiresAt: 2000 } };
    return { Item: saved };
  } } as unknown as DynamoDBDocumentClient;
  return { store: new DynamoPaymentStore(client, tables, () => 1000), original };
}
test('erro de transporte após commit recupera somente a transação da mesma tentativa', async () => {
  const { store } = fake(true);
  const result = await store.settle('alice', 'int_1', 'pix');
  assert.equal(result.status, 'aprovado');
  if (result.status === 'aprovado') assert.equal(result.limite_restante, 3100.1);
});
test('erro de infraestrutura não vira recusa de negócio ou sucesso inventado', async () => {
  const { store, original } = fake(false);
  await assert.rejects(store.settle('alice', 'int_1', 'pix'), error => error === original);
});
test('criação de intenção repete conflito temporário com o mesmo token, mas propaga falha de condição', async () => {
  let calls = 0;
  let token: string | undefined;
  const client = { async send(command: TransactWriteCommand) {
    calls++;
    if (!token) token = command.input.ClientRequestToken;
    assert.equal(command.input.ClientRequestToken, token);
    if (calls === 1) throw Object.assign(new Error('Conflito'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'TransactionConflict' }] });
  } } as unknown as DynamoDBDocumentClient;
  const store = new DynamoPaymentStore(client, tables);
  await store.saveIntent({ id: 'int_1', userId: 'alice', sku: 'PS5', quantity: 1, cents: 479900, expiresAt: 2000, status: 'pendente' });
  assert.equal(calls, 2);
  const original = Object.assign(new Error('Condição'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] });
  const failing = new DynamoPaymentStore({ async send() { throw original; } } as unknown as DynamoDBDocumentClient, tables);
  await assert.rejects(failing.saveIntent({ id: 'int_1', userId: 'alice', sku: 'PS5', quantity: 1, cents: 479900, expiresAt: 2000, status: 'pendente' }), e => e === original);
});
