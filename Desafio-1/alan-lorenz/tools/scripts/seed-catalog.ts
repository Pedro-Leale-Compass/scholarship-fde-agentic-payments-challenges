import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { PRODUCTS } from '../src/catalog.ts';

function isConditionalFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'ConditionalCheckFailedException'
  );
}

async function main() {
  const tableName = process.env.PRODUCTS_TABLE?.trim();
  if (!tableName) throw new Error('PRODUCTS_TABLE is required');

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  for (const product of PRODUCTS) {
    try {
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: product,
          ConditionExpression: 'attribute_not_exists(id)',
        }),
      );
      console.info(`Added ${product.id}`);
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      console.info(`Skipped existing product ${product.id}`);
    }
  }
}

await main();
