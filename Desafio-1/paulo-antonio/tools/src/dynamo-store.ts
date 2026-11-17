import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Approved, Intent, PaymentStore, Purchase } from './payments.ts';
import { refused } from './payments.ts';

export type Tables = { users: string; intents: string; transactions: string };
export class DynamoPaymentStore implements PaymentStore {
  private client: DynamoDBDocumentClient;
  private tables: Tables;
  private clock: () => number;
  constructor(client: DynamoDBDocumentClient, tables: Tables, clock = Date.now) {
    this.client = client; this.tables = tables; this.clock = clock;
  }

  // Backend provisioning only; never expose the initial limit as model/user input.
  async ensureUser(userId: string, initialLimitCents = 500000) {
    if (!userId.trim() || userId !== userId.trim() || !Number.isSafeInteger(initialLimitCents) || initialLimitCents < 0) throw new Error('Usuário ou limite inicial inválido.');
    try {
      await this.client.send(new PutCommand({ TableName: this.tables.users,
        Item: { userId, limit: initialLimitCents, spent: 0 }, ConditionExpression: 'attribute_not_exists(userId)' }));
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') throw error;
    }
  }

  async hasUser(userId: string) {
    const response = await this.client.send(new GetCommand({ TableName: this.tables.users, Key: { userId }, ConsistentRead: true }));
    return Boolean(response.Item);
  }

  async getAccount(userId: string) {
    const response = await this.client.send(new GetCommand({ TableName: this.tables.users, Key: { userId }, ConsistentRead: true }));
    if (!response.Item) return null;
    return { limite: response.Item.limit / 100, gasto_total: response.Item.spent / 100,
      limite_restante: (response.Item.limit - response.Item.spent) / 100, moeda: 'BRL' };
  }

  async getIntent(userId: string, id: string) {
    const response = await this.client.send(new GetCommand({ TableName: this.tables.intents, Key: { id }, ConsistentRead: true }));
    const item = response.Item;
    if (!item || item.userId !== userId) return null;
    return { intencao_id: item.id, produto_id: item.sku, quantidade: item.quantity,
      valor_total: item.cents / 100, moeda: 'BRL', status: item.status,
      expirada: this.clock() >= item.expiresAt, expira_em: new Date(item.expiresAt).toISOString(),
      ...(item.transactionId ? { transacao_id: item.transactionId } : {}) };
  }

  async saveIntent(intent: Intent) {
    const command = new TransactWriteCommand({
      ClientRequestToken: randomUUID(),
      TransactItems: [
        { ConditionCheck: { TableName: this.tables.users, Key: { userId: intent.userId }, ConditionExpression: 'attribute_exists(userId)' } },
        { Put: { TableName: this.tables.intents, Item: intent, ConditionExpression: 'attribute_not_exists(id)' } },
      ],
    });
    for (let attempt = 0; attempt < 8; attempt++) {
      try { await this.client.send(command); return; }
      catch (error) {
        const reasons = (error as { CancellationReasons?: { Code?: string }[] })?.CancellationReasons;
        if (!(error instanceof Error) || error.name !== 'TransactionCanceledException' || attempt === 7
          || !reasons?.some(r => r.Code === 'TransactionConflict')
          || reasons.some(r => r.Code && !['None', 'TransactionConflict'].includes(r.Code))) throw error;
        await delay(20 * 2 ** attempt + Math.floor(Math.random() * 30));
      }
    }
  }

  async settle(userId: string, intentId: string, rawMethod: unknown): Promise<Purchase> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const [userResult, intentResult] = await Promise.all([
        this.client.send(new GetCommand({ TableName: this.tables.users, Key: { userId }, ConsistentRead: true })),
        this.client.send(new GetCommand({ TableName: this.tables.intents, Key: { id: intentId }, ConsistentRead: true })),
      ]);
      const user = userResult.Item;
      const intent = intentResult.Item as Intent | undefined;
      if (!user || !intent || intent.userId !== userId) return refused('INTENCAO_INVALIDA');
      if (intent.status === 'paga') return refused('INTENCAO_JA_PAGA');
      const now = this.clock();
      if (now >= intent.expiresAt) return refused('INTENCAO_EXPIRADA');
      const method = typeof rawMethod === 'string' ? rawMethod.trim().toLowerCase() : '';
      if (method !== 'cartao' && method !== 'pix') return refused('METODO_INVALIDO');
      if (![user.limit, user.spent, intent.cents].every(Number.isSafeInteger)
        || user.spent < 0 || user.limit < user.spent || intent.cents <= 0 || intent.status !== 'pendente') {
        throw new Error('Dados de pagamento inconsistentes.');
      }
      if (intent.cents > user.limit - user.spent) return refused('LIMITE_EXCEDIDO');
      const attemptId = randomUUID();
      const result: Approved = { status: 'aprovado', transacao_id: `tx_${intentId}`,
        intencao_id: intentId, valor: intent.cents / 100, metodo_pagamento: method,
        limite_restante: (user.limit - user.spent - intent.cents) / 100, data: new Date(now).toISOString() };
      try {
        await this.client.send(new TransactWriteCommand({
          ClientRequestToken: attemptId,
          TransactItems: [
            { Update: { TableName: this.tables.users, Key: { userId },
              UpdateExpression: 'SET spent = :next',
              ConditionExpression: 'attribute_exists(userId) AND spent = :spent AND #limit = :limit',
              ExpressionAttributeNames: { '#limit': 'limit' },
              ExpressionAttributeValues: { ':spent': user.spent, ':limit': user.limit, ':next': user.spent + intent.cents } } },
            { Update: { TableName: this.tables.intents, Key: { id: intentId },
              UpdateExpression: 'SET #status = :paid, transactionId = :tx, paidAt = :now, paymentMethod = :method',
              ConditionExpression: 'userId = :user AND #status = :pending AND expiresAt > :now AND cents = :cents',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':paid': 'paga', ':pending': 'pendente', ':user': userId,
                ':now': now, ':cents': intent.cents, ':tx': result.transacao_id, ':method': method } } },
            { Put: { TableName: this.tables.transactions,
              Item: { id: result.transacao_id, userId, attemptId, result }, ConditionExpression: 'attribute_not_exists(id)' } },
          ],
        }));
        return result;
      } catch (error) {
        // An ambiguous transport failure may follow a committed transaction. Only
        // recover a result belonging to this exact attempt, never another request.
        if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') {
          try {
            const saved = await this.client.send(new GetCommand({ TableName: this.tables.transactions,
              Key: { id: result.transacao_id }, ConsistentRead: true }));
            if (saved.Item?.attemptId === attemptId && saved.Item?.userId === userId) return saved.Item.result as Approved;
          } catch { /* Preserve original infrastructure error, never claim refusal. */ }
          throw error;
        }
        const reasons = (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
        if (!reasons?.some(r => ['ConditionalCheckFailed', 'TransactionConflict'].includes(r.Code ?? ''))
          || reasons.some(r => r.Code && !['None', 'ConditionalCheckFailed', 'TransactionConflict'].includes(r.Code))) throw error;
        // Read fresh balances/status and recheck expiry on every optimistic retry.
        await delay(20 * 2 ** attempt + Math.floor(Math.random() * 30));
      }
    }
    throw new Error('Pagamento ocupado. Consulte a intenção antes de tentar novamente.');
  }
}
