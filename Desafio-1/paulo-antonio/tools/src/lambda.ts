import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoPaymentStore } from './dynamo-store.ts';
import { createHttpHandler } from './http-handler.ts';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Configuração ausente: ${name}`);
  return value;
}
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 3 }));
const store = new DynamoPaymentStore(client, { users: required('USERS_TABLE'), intents: required('INTENTS_TABLE'), transactions: required('TRANSACTIONS_TABLE') });
export const handler = createHttpHandler(store, required('FRONTEND_ORIGIN'));
