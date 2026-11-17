import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

export const DEFAULT_LIMIT_CENTS = 100_000;

const dynamoDb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function ensureChatUser(
  userId: string,
  tableName = process.env.USERS_TABLE?.trim(),
): Promise<void> {
  if (!tableName) {
    throw new Error('USERS_TABLE is required');
  }

  try {
    await dynamoDb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          userId,
          limite_cents: DEFAULT_LIMIT_CENTS,
          limite_restante_cents: DEFAULT_LIMIT_CENTS,
        },
        ConditionExpression: 'attribute_not_exists(userId)',
      }),
    );
  } catch (error) {
    if (isRecord(error) && error.name === 'ConditionalCheckFailedException') {
      return;
    }
    throw error;
  }
}
