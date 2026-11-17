import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_LIMIT_CENTS,
  DuplicateIntentionError,
  PurchaseConflictError,
  type Intention,
  type PaymentStore,
  type Product,
  type PurchaseTransaction,
  type UserProfile,
} from './types.ts';
import { PRODUCTS } from './catalog.ts';
import { createPaymentTools } from './tools.ts';

const USER_ID = 'cognito-sub-123';
const CONVERSATION_ID = '3f1a9c2e-7b48-4d6a-9f01-2c5e8a4b7d13';
const NOW = new Date('2026-08-31T12:00:00.000Z');

function isRejected(
  value: unknown,
): value is { status: 'recusado'; erro: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    value.status === 'recusado' &&
    'erro' in value &&
    typeof value.erro === 'string'
  );
}

function errorCode(value: unknown): string {
  assert.ok(isRejected(value));
  return value.erro;
}

class MemoryPaymentStore implements PaymentStore {
  readonly products = new Map(PRODUCTS.map((product) => [product.id, { ...product }]));
  readonly intentions = new Map<string, Intention>();
  readonly users = new Map<string, UserProfile>();
  readonly transactions = new Map<string, PurchaseTransaction>();

  listProducts(): Promise<Product[]> {
    return Promise.resolve([...this.products.values()].map((product) => ({ ...product })));
  }

  getProduct(productId: string): Promise<Product | undefined> {
    const product = this.products.get(productId);
    return Promise.resolve(product ? { ...product } : undefined);
  }

  getIntention(intentionId: string): Promise<Intention | undefined> {
    const intention = this.intentions.get(intentionId);
    return Promise.resolve(intention ? { ...intention } : undefined);
  }

  getUser(userId: string): Promise<UserProfile | undefined> {
    const user = this.users.get(userId);
    return Promise.resolve(user ? { ...user } : undefined);
  }

  ensureUser(userId: string, initialLimitCents: number): Promise<UserProfile> {
    let user = this.users.get(userId);
    if (!user) {
      user = {
        userId,
        limite_cents: initialLimitCents,
        limite_restante_cents: initialLimitCents,
      };
      this.users.set(userId, user);
    }
    return Promise.resolve({ ...user });
  }

  putIntention(intention: Intention): Promise<void> {
    if (this.intentions.has(intention.intentionId)) {
      return Promise.reject(new DuplicateIntentionError());
    }
    this.intentions.set(intention.intentionId, { ...intention });
    return Promise.resolve();
  }

  cancelIntention(intention: Intention): Promise<boolean> {
    const current = this.intentions.get(intention.intentionId);
    if (
      !current ||
      current.status !== 'pendente' ||
      current.userId !== intention.userId ||
      current.conversaId !== intention.conversaId
    ) {
      return Promise.resolve(false);
    }
    current.status = 'cancelada_estoque';
    return Promise.resolve(true);
  }

  completePurchase(transaction: PurchaseTransaction): Promise<void> {
    const { intention, userId, transactionId, transactionDate } = transaction;
    const currentIntention = this.intentions.get(intention.intentionId);
    const user = this.users.get(userId);
    const product = this.products.get(intention.produto_id);

    if (
      !currentIntention ||
      currentIntention.status !== 'pendente' ||
      currentIntention.userId !== userId ||
      currentIntention.conversaId !== intention.conversaId ||
      currentIntention.expira_em < transactionDate ||
      !user ||
      user.limite_restante_cents < intention.valor_total_cents ||
      !product ||
      product.estoque < intention.quantidade ||
      this.transactions.has(intention.intentionId)
    ) {
      return Promise.reject(new PurchaseConflictError());
    }

    currentIntention.status = 'paga';
    user.limite_restante_cents -= intention.valor_total_cents;
    product.estoque -= intention.quantidade;
    this.transactions.set(intention.intentionId, { ...transaction });
    return Promise.resolve();
  }

}

function createTestTools(
  store: MemoryPaymentStore,
  options: {
    initialLimitCents?: number;
    now?: Date;
    intentionIds?: string[];
  } = {},
) {
  let nextId = 0;
  const intentionIds = options.intentionIds ?? ['int_123456'];
  return createPaymentTools(store, {
    initialLimitCents: options.initialLimitCents,
    now: () => options.now ?? NOW,
    createIntentionId: () => intentionIds[nextId++] ?? `int_${nextId}`,
    createTransactionId: () => 'tx_1234567890abcdef',
  });
}

test('listarCatalogo mantém o contrato público e filtra categoria sem diferenciar caixa', async () => {
  const tools = createTestTools(new MemoryPaymentStore());
  const catalog = await tools.listarCatalogo();

  assert.equal(catalog.produtos.length, 5);
  assert.deepEqual(catalog.produtos[0], {
    id: 'prod_001',
    nome: 'Fone Bluetooth',
    moeda: 'BRL',
    estoque: 20,
    preco: 249.9,
  });
  assert.deepEqual(await tools.listarCatalogo({ categoria: ' MONITORES ' }), {
    produtos: [
      {
        id: 'prod_003',
        nome: 'Monitor 27" 144Hz',
        moeda: 'BRL',
        estoque: 8,
        preco: 1899.9,
      },
    ],
  });
  assert.deepEqual(await tools.listarCatalogo({ categoria: 'inexistente' }), {
    produtos: [],
  });
});

test('registrarIntencao calcula o valor no backend, vence em cinco minutos e não reserva estoque', async () => {
  const store = new MemoryPaymentStore();
  const tools = createTestTools(store);
  const result = await tools.registrarIntencao(USER_ID, CONVERSATION_ID, {
    produto_id: 'prod_002',
    quantidade: 2,
  });

  assert.deepEqual(result, {
    intencao_id: 'int_123456',
    produto_id: 'prod_002',
    quantidade: 2,
    valor_total: 919.8,
    moeda: 'BRL',
    status: 'pendente',
    expira_em: '2026-08-31T12:05:00.000Z',
    valido_por_minutos: 5,
  });
  assert.equal(store.intentions.get('int_123456')?.valor_total_cents, 91980);
  assert.equal(store.intentions.get('int_123456')?.userId, USER_ID);
  assert.equal(store.intentions.get('int_123456')?.conversaId, CONVERSATION_ID);
  assert.equal(store.users.get(USER_ID)?.limite_cents, DEFAULT_LIMIT_CENTS);
  assert.equal(store.products.get('prod_002')?.estoque, 15);
});

test('registrarIntencao recusa produto, quantidade e estoque inválidos', async () => {
  const store = new MemoryPaymentStore();
  const tools = createTestTools(store);

  assert.equal(
    errorCode(await tools.registrarIntencao(USER_ID, CONVERSATION_ID, {
      produto_id: 'missing',
      quantidade: 1,
    })),
    'PRODUTO_INEXISTENTE',
  );
  assert.equal(
    errorCode(await tools.registrarIntencao(USER_ID, CONVERSATION_ID, {
      produto_id: 'prod_001',
      quantidade: 1.5,
    })),
    'QUANTIDADE_INVALIDA',
  );
  assert.equal(
    errorCode(await tools.registrarIntencao(USER_ID, CONVERSATION_ID, {
      produto_id: 'prod_004',
      quantidade: 6,
    })),
    'ESTOQUE_INSUFICIENTE',
  );
  assert.equal(store.users.size, 0);
});

test('realizarCompra aprova cartão ou Pix e altera intenção, saldo, estoque e transação', async () => {
  const store = new MemoryPaymentStore();
  const tools = createTestTools(store);
  await tools.registrarIntencao(USER_ID, CONVERSATION_ID, {
    produto_id: 'prod_001',
    quantidade: 2,
  });

  const result = await tools.realizarCompra(USER_ID, CONVERSATION_ID, {
    intencao_id: 'int_123456',
    metodo_pagamento: 'cartao',
  });

  assert.deepEqual(result, {
    status: 'aprovado',
    transacao_id: 'tx_1234567890abcdef',
    intencao_id: 'int_123456',
    valor: 499.8,
    metodo_pagamento: 'cartao',
    limite_restante: 500.2,
    data: NOW.toISOString(),
  });
  assert.equal(store.intentions.get('int_123456')?.status, 'paga');
  assert.equal(store.users.get(USER_ID)?.limite_restante_cents, 50020);
  assert.equal(store.products.get('prod_001')?.estoque, 18);
  assert.equal(store.transactions.size, 1);

  const repeated = await tools.realizarCompra(USER_ID, CONVERSATION_ID, {
    intencao_id: 'int_123456',
    metodo_pagamento: 'pix',
  });
  assert.equal(errorCode(repeated), 'INTENCAO_JA_PAGA');
});

test('realizarCompra respeita limite exato, recusa excesso e mantém a prioridade de validação', async () => {
  const rejectedStore = new MemoryPaymentStore();
  const rejectedTools = createTestTools(rejectedStore, { initialLimitCents: 24989 });
  await rejectedTools.registrarIntencao(USER_ID, CONVERSATION_ID, {
    produto_id: 'prod_001',
    quantidade: 1,
  });
  const rejected = await rejectedTools.realizarCompra(USER_ID, CONVERSATION_ID, {
    intencao_id: 'int_123456',
    metodo_pagamento: 'pix',
  });
  assert.equal(errorCode(rejected), 'LIMITE_EXCEDIDO');
  assert.equal(rejectedStore.transactions.size, 0);

  const exactStore = new MemoryPaymentStore();
  const exactTools = createTestTools(exactStore, { initialLimitCents: 24990 });
  await exactTools.registrarIntencao(USER_ID, CONVERSATION_ID, {
    produto_id: 'prod_001',
    quantidade: 1,
  });
  const approved = await exactTools.realizarCompra(USER_ID, CONVERSATION_ID, {
    intencao_id: 'int_123456',
    metodo_pagamento: 'pix',
  });
  assert.equal(approved.status, 'aprovado');
  assert.equal(approved.limite_restante, 0);

  const paid = exactStore.intentions.get('int_123456');
  assert.ok(paid);
  paid.status = 'paga';
  paid.expira_em = '2020-01-01T00:00:00.000Z';
  const invalidMethod = await exactTools.realizarCompra(USER_ID, CONVERSATION_ID, {
    intencao_id: 'int_123456',
    metodo_pagamento: 'boleto',
  });
  assert.equal(errorCode(invalidMethod), 'INTENCAO_JA_PAGA');
});

test('realizarCompra vincula intenção ao usuário e à conversa e aceita no instante da expiração', async () => {
  const store = new MemoryPaymentStore();
  const tools = createTestTools(store);
  await tools.registrarIntencao(USER_ID, CONVERSATION_ID, {
    produto_id: 'prod_001',
    quantidade: 1,
  });

  assert.equal(
    errorCode(await tools.realizarCompra('another-user', CONVERSATION_ID, {
      intencao_id: 'int_123456',
      metodo_pagamento: 'pix',
    })),
    'INTENCAO_INVALIDA',
  );
  assert.equal(
    errorCode(await tools.realizarCompra(USER_ID, 'another-conversation', {
      intencao_id: 'int_123456',
      metodo_pagamento: 'pix',
    })),
    'INTENCAO_INVALIDA',
  );

  const boundaryTools = createTestTools(store, {
    now: new Date('2026-08-31T12:05:00.000Z'),
  });
  const boundary = await boundaryTools.realizarCompra(USER_ID, CONVERSATION_ID, {
    intencao_id: 'int_123456',
    metodo_pagamento: 'pix',
  });
  assert.equal(boundary.status, 'aprovado');
});

test('realizarCompra recusa intenção expirada e cancela se o estoque acabar antes do pagamento', async () => {
  const expiredStore = new MemoryPaymentStore();
  const expiredTools = createTestTools(expiredStore);
  await expiredTools.registrarIntencao(USER_ID, CONVERSATION_ID, {
    produto_id: 'prod_001',
    quantidade: 1,
  });
  const expired = await createTestTools(expiredStore, {
    now: new Date('2026-08-31T12:05:00.001Z'),
  }).realizarCompra(USER_ID, CONVERSATION_ID, {
    intencao_id: 'int_123456',
    metodo_pagamento: 'pix',
  });
  assert.equal(errorCode(expired), 'INTENCAO_EXPIRADA');

  const stockStore = new MemoryPaymentStore();
  const stockTools = createTestTools(stockStore);
  await stockTools.registrarIntencao(USER_ID, CONVERSATION_ID, {
    produto_id: 'prod_001',
    quantidade: 1,
  });
  const product = stockStore.products.get('prod_001');
  assert.ok(product);
  product.estoque = 0;

  const unavailable = await stockTools.realizarCompra(USER_ID, CONVERSATION_ID, {
    intencao_id: 'int_123456',
    metodo_pagamento: 'pix',
  });
  assert.equal(errorCode(unavailable), 'INTENCAO_INVALIDA');
  assert.equal(stockStore.intentions.get('int_123456')?.status, 'cancelada_estoque');
  assert.equal(stockStore.transactions.size, 0);
});
