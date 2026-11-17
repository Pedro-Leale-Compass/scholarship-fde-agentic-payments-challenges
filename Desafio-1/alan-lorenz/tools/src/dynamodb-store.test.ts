import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoPaymentStore, tableNamesFromEnvironment } from './dynamodb-store.ts';
import {
  DuplicateIntentionError,
  PurchaseConflictError,
  type Intention,
  type PurchaseTransaction,
} from './types.ts';

const tables = {
  products: 'Products',
  users: 'Users',
  intentions: 'Intentions',
  transactions: 'Transactions',
};
const documentClientMock = mockClient(DynamoDBDocumentClient);

function createStore() {
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: 'us-east-1' }),
  );
  return new DynamoPaymentStore(client, tables);
}

function sampleIntention(): Intention {
  return {
    intentionId: 'int_123456',
    produto_id: 'prod_001',
    quantidade: 2,
    valor_total_cents: 49980,
    status: 'pendente',
    userId: 'cognito-sub-123',
    conversaId: '3f1a9c2e-7b48-4d6a-9f01-2c5e8a4b7d13',
    criada_em: '2026-08-31T12:00:00.000Z',
    expira_em: '2026-08-31T12:05:00.000Z',
  };
}

function samplePurchase(): PurchaseTransaction {
  return {
    intention: sampleIntention(),
    userId: 'cognito-sub-123',
    transactionId: 'tx_1234567890abcdef',
    paymentMethod: 'pix',
    transactionDate: '2026-08-31T12:00:00.000Z',
  };
}

afterEach(() => documentClientMock.reset());

test('tableNamesFromEnvironment requires every configured table', () => {
  assert.deepEqual(
    tableNamesFromEnvironment({
      PRODUCTS_TABLE: ' Products ',
      USERS_TABLE: 'Users',
      INTENTIONS_TABLE: 'Intentions',
      TRANSACTIONS_TABLE: 'Transactions',
    }),
    tables,
  );
  assert.throws(
    () => tableNamesFromEnvironment({ PRODUCTS_TABLE: 'Products' }),
    /USERS_TABLE is required/,
  );
});

test('ensureUser initializes a new profile and reuses an existing profile on a race', async () => {
  const store = createStore();
  documentClientMock.on(PutCommand).resolves({});
  const created = await store.ensureUser('cognito-sub-123', 100000);
  assert.deepEqual(created, {
    userId: 'cognito-sub-123',
    limite_cents: 100000,
    limite_restante_cents: 100000,
  });

  documentClientMock.reset();
  documentClientMock.on(PutCommand).rejects(
    Object.assign(new Error('conditional check failed'), {
      name: 'ConditionalCheckFailedException',
    }),
  );
  documentClientMock.on(GetCommand).resolves({
    Item: {
      userId: 'cognito-sub-123',
      limite_cents: 100000,
      limite_restante_cents: 75010,
    },
  });
  const existing = await store.ensureUser('cognito-sub-123', 100000);
  assert.equal(existing.limite_restante_cents, 75010);
});

test('putIntention uses a conditional insert to avoid replacing another intention', async () => {
  const store = createStore();
  documentClientMock.on(PutCommand).rejects(
    Object.assign(new Error('conditional check failed'), {
      name: 'ConditionalCheckFailedException',
    }),
  );

  await assert.rejects(store.putIntention(sampleIntention()), DuplicateIntentionError);
  const call = documentClientMock.commandCalls(PutCommand)[0];
  assert.equal(call.args[0].input.ConditionExpression, 'attribute_not_exists(intentionId)');
});

test('purchase is one conditional DynamoDB transaction across intent, limit, stock, and transaction', async () => {
  const store = createStore();
  documentClientMock.on(TransactWriteCommand).resolves({});
  await store.completePurchase(samplePurchase());

  const calls = documentClientMock.commandCalls(TransactWriteCommand);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  const items = call.args[0].input.TransactItems;
  assert.ok(items);
  assert.equal(items.length, 4);

  const intentionUpdate = items[0];
  const userUpdate = items[1];
  const productUpdate = items[2];
  const transactionPut = items[3];
  assert.ok(intentionUpdate?.Update);
  assert.match(intentionUpdate.Update.ConditionExpression ?? '', /#status = :pending/);
  assert.match(intentionUpdate.Update.ConditionExpression ?? '', /userId = :userId/);
  assert.match(intentionUpdate.Update.ConditionExpression ?? '', /conversaId = :conversaId/);
  assert.match(intentionUpdate.Update.ConditionExpression ?? '', /expira_em >= :date/);

  assert.ok(userUpdate?.Update);
  assert.match(userUpdate.Update.ConditionExpression ?? '', /limite_restante_cents >= :amount/);
  assert.match(userUpdate.Update.UpdateExpression ?? '', /limite_restante_cents - :amount/);

  assert.ok(productUpdate?.Update);
  assert.equal(productUpdate.Update.ConditionExpression, 'estoque >= :quantity');
  assert.match(productUpdate.Update.UpdateExpression ?? '', /estoque - :quantity/);

  assert.ok(transactionPut?.Put);
  assert.equal(
    transactionPut.Put.ConditionExpression,
    'attribute_not_exists(intentionId)',
  );
  const transactionItem = transactionPut.Put.Item;
  assert.ok(transactionItem);
  assert.equal(transactionItem.intentionId, 'int_123456');
  assert.equal(transactionItem.valor_cents, 49980);
});

test('DynamoDB transaction cancellation is surfaced as a purchase conflict', async () => {
  const store = createStore();
  documentClientMock.on(TransactWriteCommand).rejects(
    Object.assign(new Error('transaction cancelled'), {
      name: 'TransactionCanceledException',
    }),
  );

  await assert.rejects(store.completePurchase(samplePurchase()), PurchaseConflictError);
});
