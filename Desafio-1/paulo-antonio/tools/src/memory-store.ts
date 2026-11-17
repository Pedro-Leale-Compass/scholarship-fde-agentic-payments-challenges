import { randomUUID } from 'node:crypto';
import { refused } from './payments.ts';
import type { Approved, Intent, PaymentStore, Purchase } from './payments.ts';

// Local testing only. One process, volatile state. Never use as Lambda persistence.
export class MemoryPaymentStore implements PaymentStore {
  #users = new Map<string, { limit: number; spent: number }>();
  #intents = new Map<string, Intent>();
  #transactions = new Map<string, Approved>();
  #clock: () => number;

  constructor(users: { usuario_id: string; limite_centavos: number }[], clock = Date.now) {
    this.#clock = clock;
    for (const user of users) {
      if (!user.usuario_id.trim() || user.usuario_id !== user.usuario_id.trim() || this.#users.has(user.usuario_id)
        || !Number.isSafeInteger(user.limite_centavos) || user.limite_centavos < 0) throw new Error('Usuário ou limite inicial inválido.');
      this.#users.set(user.usuario_id, { limit: user.limite_centavos, spent: 0 });
    }
  }

  async hasUser(userId: string) { return this.#users.has(userId); }

  async saveIntent(intent: Intent) {
    if (this.#intents.has(intent.id)) throw new Error('Identificador de intenção duplicado.');
    if (!this.#users.has(intent.userId)) throw new Error('Usuário não cadastrado.');
    this.#intents.set(intent.id, { ...intent });
  }

  async settle(userId: string, intentId: string, rawMethod: unknown): Promise<Purchase> {
    // No await between validation and writes: indivisible within this process only.
    const user = this.#users.get(userId);
    const intent = this.#intents.get(intentId);
    if (!user || !intent || intent.userId !== userId) return refused('INTENCAO_INVALIDA');
    if (intent.status === 'paga') return refused('INTENCAO_JA_PAGA');
    const now = this.#clock();
    if (now >= intent.expiresAt) return refused('INTENCAO_EXPIRADA');
    const method = typeof rawMethod === 'string' ? rawMethod.trim().toLowerCase() : '';
    if (method !== 'cartao' && method !== 'pix') return refused('METODO_INVALIDO');
    if (intent.cents > user.limit - user.spent) return refused('LIMITE_EXCEDIDO');
    const result: Approved = { status: 'aprovado', transacao_id: `tx_${randomUUID()}`,
      intencao_id: intent.id, valor: intent.cents / 100, metodo_pagamento: method,
      limite_restante: (user.limit - user.spent - intent.cents) / 100, data: new Date(now).toISOString() };
    user.spent += intent.cents;
    intent.status = 'paga';
    this.#transactions.set(result.transacao_id, { ...result });
    return result;
  }

  // Defensive copies for local test inspection, not exposed as model tools.
  snapshot() {
    return structuredClone({ users: [...this.#users.entries()], intents: [...this.#intents.values()], transactions: [...this.#transactions.values()] });
  }
}
