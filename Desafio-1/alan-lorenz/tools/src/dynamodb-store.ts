import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  DuplicateIntentionError,
  PurchaseConflictError,
  type Intention,
  type PaymentStore,
  type Product,
  type PurchaseTransaction,
  type UserProfile,
} from './types.ts';

export type DynamoTableNames = {
  products: string;
  users: string;
  intentions: string;
  transactions: string;
};

function requiredTableName(value: string | undefined, variable: string): string {
  const tableName = value?.trim();
  if (!tableName) throw new Error(`${variable} is required`);
  return tableName;
}

export function tableNamesFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): DynamoTableNames {
  return {
    products: requiredTableName(env.PRODUCTS_TABLE, 'PRODUCTS_TABLE'),
    users: requiredTableName(env.USERS_TABLE, 'USERS_TABLE'),
    intentions: requiredTableName(env.INTENTIONS_TABLE, 'INTENTIONS_TABLE'),
    transactions: requiredTableName(
      env.TRANSACTIONS_TABLE,
      'TRANSACTIONS_TABLE',
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  itemType: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${itemType} item: ${key} must be a non-empty string`);
  }
  return value;
}

function requiredInteger(
  record: Record<string, unknown>,
  key: string,
  itemType: string,
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid ${itemType} item: ${key} must be a safe integer`);
  }
  return value;
}

function parseProduct(item: unknown): Product {
  if (!isRecord(item)) throw new Error('Invalid product item');
  return {
    id: requiredString(item, 'id', 'product'),
    nome: requiredString(item, 'nome', 'product'),
    preco_cents: requiredInteger(item, 'preco_cents', 'product'),
    moeda: requiredString(item, 'moeda', 'product'),
    estoque: requiredInteger(item, 'estoque', 'product'),
    categoria: requiredString(item, 'categoria', 'product'),
  };
}

function parseIntention(item: unknown): Intention {
  if (!isRecord(item)) throw new Error('Invalid intention item');
  return {
    intentionId: requiredString(item, 'intentionId', 'intention'),
    produto_id: requiredString(item, 'produto_id', 'intention'),
    quantidade: requiredInteger(item, 'quantidade', 'intention'),
    valor_total_cents: requiredInteger(item, 'valor_total_cents', 'intention'),
    status: requiredString(item, 'status', 'intention'),
    userId: requiredString(item, 'userId', 'intention'),
    conversaId: requiredString(item, 'conversaId', 'intention'),
    criada_em: requiredString(item, 'criada_em', 'intention'),
    expira_em: requiredString(item, 'expira_em', 'intention'),
  };
}

function parseUser(item: unknown): UserProfile {
  if (!isRecord(item)) throw new Error('Invalid user profile item');
  return {
    userId: requiredString(item, 'userId', 'user profile'),
    limite_cents: requiredInteger(item, 'limite_cents', 'user profile'),
    limite_restante_cents: requiredInteger(
      item,
      'limite_restante_cents',
      'user profile',
    ),
  };
}

function isConditionalFailure(error: unknown): boolean {
  return isRecord(error) && error.name === 'ConditionalCheckFailedException';
}

function isTransactionCanceled(error: unknown): boolean {
  return isRecord(error) && error.name === 'TransactionCanceledException';
}

export class DynamoPaymentStore implements PaymentStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tables: DynamoTableNames,
  ) {}

  async listProducts(): Promise<Product[]> {
    const response = await this.client.send(
      new ScanCommand({ TableName: this.tables.products }),
    );
    return (response.Items ?? []).map(parseProduct);
  }

  async getProduct(productId: string): Promise<Product | undefined> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tables.products,
        Key: { id: productId },
        ConsistentRead: true,
      }),
    );
    return response.Item ? parseProduct(response.Item) : undefined;
  }

  async getIntention(intentionId: string): Promise<Intention | undefined> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tables.intentions,
        Key: { intentionId },
        ConsistentRead: true,
      }),
    );
    return response.Item ? parseIntention(response.Item) : undefined;
  }

  async getUser(userId: string): Promise<UserProfile | undefined> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tables.users,
        Key: { userId },
        ConsistentRead: true,
      }),
    );
    return response.Item ? parseUser(response.Item) : undefined;
  }

  async ensureUser(
    userId: string,
    initialLimitCents: number,
  ): Promise<UserProfile> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tables.users,
          Item: {
            userId,
            limite_cents: initialLimitCents,
            limite_restante_cents: initialLimitCents,
          },
          ConditionExpression: 'attribute_not_exists(userId)',
        }),
      );
      return {
        userId,
        limite_cents: initialLimitCents,
        limite_restante_cents: initialLimitCents,
      };
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const existing = await this.getUser(userId);
      if (!existing) throw error;
      return existing;
    }
  }

  async putIntention(intention: Intention): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tables.intentions,
          Item: intention,
          ConditionExpression: 'attribute_not_exists(intentionId)',
        }),
      );
    } catch (error) {
      if (isConditionalFailure(error)) throw new DuplicateIntentionError();
      throw error;
    }
  }

  async cancelIntention(intention: Intention): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tables.intentions,
          Key: { intentionId: intention.intentionId },
          UpdateExpression: 'SET #status = :cancelled',
          ConditionExpression:
            'userId = :userId AND conversaId = :conversaId AND #status = :pending',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':cancelled': 'cancelada_estoque',
            ':pending': 'pendente',
            ':userId': intention.userId,
            ':conversaId': intention.conversaId,
          },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  }

  async completePurchase(transaction: PurchaseTransaction): Promise<void> {
    const { intention, userId, transactionId, paymentMethod, transactionDate } =
      transaction;
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tables.intentions,
                Key: { intentionId: intention.intentionId },
                UpdateExpression:
                  'SET #status = :paid, transacao_id = :transactionId, metodo_pagamento = :method, data_pagamento = :date',
                ConditionExpression:
                  'userId = :userId AND conversaId = :conversaId AND #status = :pending AND expira_em >= :date',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':paid': 'paga',
                  ':pending': 'pendente',
                  ':userId': userId,
                  ':conversaId': intention.conversaId,
                  ':transactionId': transactionId,
                  ':method': paymentMethod,
                  ':date': transactionDate,
                },
              },
            },
            {
              Update: {
                TableName: this.tables.users,
                Key: { userId },
                UpdateExpression:
                  'SET limite_restante_cents = limite_restante_cents - :amount',
                ConditionExpression:
                  'attribute_exists(userId) AND limite_restante_cents >= :amount',
                ExpressionAttributeValues: {
                  ':amount': intention.valor_total_cents,
                },
              },
            },
            {
              Update: {
                TableName: this.tables.products,
                Key: { id: intention.produto_id },
                UpdateExpression: 'SET estoque = estoque - :quantity',
                ConditionExpression: 'estoque >= :quantity',
                ExpressionAttributeValues: {
                  ':quantity': intention.quantidade,
                },
              },
            },
            {
              Put: {
                TableName: this.tables.transactions,
                Item: {
                  intentionId: intention.intentionId,
                  transactionId,
                  userId,
                  valor_cents: intention.valor_total_cents,
                  metodo_pagamento: paymentMethod,
                  data: transactionDate,
                },
                ConditionExpression: 'attribute_not_exists(intentionId)',
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isTransactionCanceled(error)) throw new PurchaseConflictError(error);
      throw error;
    }
  }

}

export function createDynamoPaymentStore(
  tables: DynamoTableNames = tableNamesFromEnvironment(),
): DynamoPaymentStore {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return new DynamoPaymentStore(client, tables);
}
