import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createToolHandlers } from './inputs.ts';
import type { PaymentStore } from '../types.ts';

const VALID_CONTEXT = {
  authenticatedContext: {
    userId: 'cognito-sub-from-jwt',
    conversaId: '3f1a9c2e-7b48-4d6a-9f01-2c5e8a4b7d13',
  },
  arguments: {},
};

function hasProducts(value: unknown): value is { produtos: unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'produtos' in value &&
    Array.isArray(value.produtos)
  );
}

function unusedStore(): PaymentStore {
  const unexpected = () => Promise.reject(new Error('store should not be called'));
  return {
    listProducts: unexpected,
    getProduct: unexpected,
    getIntention: unexpected,
    getUser: unexpected,
    ensureUser: unexpected,
    putIntention: unexpected,
    cancelIntention: unexpected,
    completePurchase: unexpected,
  };
}

test('tool handlers require authenticated identity separate from model arguments', async () => {
  const handlers = createToolHandlers(unusedStore());
  await assert.rejects(handlers.listar_catalogo({ arguments: {} }), /Authenticated tool context/);
  await assert.rejects(
    handlers.listar_catalogo({
      authenticatedContext: { userId: '', conversaId: VALID_CONTEXT.authenticatedContext.conversaId },
      arguments: {},
    }),
    /Authenticated user id/,
  );
  await assert.rejects(
    handlers.listar_catalogo({
      authenticatedContext: { ...VALID_CONTEXT.authenticatedContext, conversaId: 'conversation-1' },
      arguments: {},
    }),
    /UUID v4/,
  );
});

test('tool handlers execute catalog calls without conversation audit storage', async () => {
  const store: PaymentStore = {
    ...unusedStore(),
    listProducts: async () => [
      {
        id: 'prod_001',
        nome: 'Fone Bluetooth',
        preco_cents: 24990,
        moeda: 'BRL',
        estoque: 20,
        categoria: 'audio',
      },
    ],
  };
  const handlers = createToolHandlers(store);

  const result = await handlers.listar_catalogo({
    authenticatedContext: VALID_CONTEXT.authenticatedContext,
    arguments: { userId: 'model-supplied-user', categoria: 'audio' },
  });

  assert.ok(hasProducts(result));
  assert.equal(result.produtos.length, 1);
});
