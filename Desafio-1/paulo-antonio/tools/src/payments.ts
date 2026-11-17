import { randomUUID } from 'node:crypto';
import { BadArgs, CATALOG, listarCatalogo, objectArgs } from './catalog.ts';

export { BadArgs, listarCatalogo };
export const INTENCAO_EXPIRA_SEGUNDOS = 180;
export type Context = Readonly<{ usuario_id: string }>;
export type Method = 'cartao' | 'pix';
export type RefusalCode = 'INTENCAO_INVALIDA' | 'INTENCAO_JA_PAGA' | 'INTENCAO_EXPIRADA' | 'LIMITE_EXCEDIDO' | 'METODO_INVALIDO';
export type Approved = { status: 'aprovado'; transacao_id: string; intencao_id: string; valor: number; metodo_pagamento: Method; limite_restante: number; data: string };
export type Purchase = Approved | { status: 'recusado'; erro: RefusalCode; mensagem: string };
export type Intent = { id: string; userId: string; sku: string; quantity: number; cents: number; expiresAt: number; status: 'pendente' | 'paga' };

// Production adapters MUST enforce owner, expiry, unpaid status, balance and unique
// transaction together atomically. Independent read-then-write operations are unsafe.
export interface PaymentStore {
  hasUser(userId: string): Promise<boolean>;
  saveIntent(intent: Intent): Promise<void>;
  settle(userId: string, intentId: string, method: unknown): Promise<Purchase>;
}

function identity(context: unknown): string | null {
  if (!context || typeof context !== 'object') return null;
  const id = (context as Record<string, unknown>).usuario_id;
  return typeof id === 'string' && id.trim() && id === id.trim() ? id : null;
}

export function refused(erro: RefusalCode): Purchase {
  const messages: Record<RefusalCode, string> = {
    INTENCAO_INVALIDA: 'Intenção indisponível para o usuário autenticado.',
    INTENCAO_JA_PAGA: 'Essa intenção já foi utilizada em uma compra.',
    INTENCAO_EXPIRADA: 'A intenção expirou. Registre uma nova intenção.',
    LIMITE_EXCEDIDO: 'O valor excede o limite restante do usuário.',
    METODO_INVALIDO: 'Método inválido. Use cartao ou pix.',
  };
  return { status: 'recusado', erro, mensagem: messages[erro] };
}

export function createPaymentTools(store: PaymentStore, clock = Date.now) {
  return {
    listar_catalogo: listarCatalogo,
    async registrar_intencao(input: unknown, context: unknown) {
      const userId = identity(context);
      if (!userId || !await store.hasUser(userId)) throw new BadArgs('Usuário autenticado inválido.');
      const args = objectArgs(input);
      const quantity = args.quantidade;
      if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity <= 0) {
        throw new BadArgs('Quantidade deve ser um número inteiro positivo.');
      }
      const sku = typeof args.sku === 'string' ? args.sku.trim().toUpperCase() : '';
      const item = CATALOG.find(item => item.sku === sku);
      if (!item) throw new BadArgs('SKU não encontrado. Consulte o catálogo.');
      const cents = item.cents * quantity;
      if (!Number.isSafeInteger(cents)) throw new BadArgs('Valor total fora do intervalo suportado.');
      const intent: Intent = { id: `int_${randomUUID()}`, userId, sku, quantity, cents,
        expiresAt: clock() + INTENCAO_EXPIRA_SEGUNDOS * 1000, status: 'pendente' };
      await store.saveIntent(intent);
      return { intencao_id: intent.id, produto_id: sku, quantidade: quantity, valor_total: cents / 100,
        moeda: 'BRL', status: 'pendente' as const, expira_em: new Date(intent.expiresAt).toISOString() };
    },
    async realizar_compra(input: unknown, context: unknown): Promise<Purchase> {
      const userId = identity(context);
      if (!userId || !input || typeof input !== 'object' || Array.isArray(input)) return refused('INTENCAO_INVALIDA');
      const args = input as Record<string, unknown>;
      const id = typeof args.intencao_id === 'string' ? args.intencao_id.trim() : '';
      if (!id) return refused('INTENCAO_INVALIDA');
      // Price, user IDs and transaction IDs in model arguments are never used.
      return store.settle(userId, id, args.metodo_pagamento);
    },
  };
}
