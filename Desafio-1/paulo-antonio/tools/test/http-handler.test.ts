import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpHandler } from '../src/http-handler.ts';
import { MemoryPaymentStore } from '../src/memory-store.ts';

function setup() {
  const store = new MemoryPaymentStore([{ usuario_id: 'alice', limite_centavos: 500000 }, { usuario_id: 'bob', limite_centavos: 3000000 }]);
  const provisioned: string[] = [];
  const adapter = Object.assign(store, {
    async ensureUser(id: string) { provisioned.push(id); },
    async getAccount(id: string) { return { userId: id }; },
    async getIntent(id: string, intentId: string) { return store.snapshot().intents.find(i => i.userId === id && i.id === intentId) ?? null; },
  });
  const handler = createHttpHandler(adapter, 'http://127.0.0.1:4173');
  const call = (method: string, resource: string, body?: unknown, sub: unknown = 'alice', id?: string) => handler({
    httpMethod: method, resource, body: body === undefined ? null : JSON.stringify(body),
    requestContext: { authorizer: { claims: { sub } } }, pathParameters: id ? { id } : null,
  });
  return { handler, store, call, provisioned };
}

test('todas as rotas recusam contexto inválido antes de ler ou provisionar dados', async () => {
  const { call, provisioned, store } = setup();
  for (const [method, resource] of [['GET', '/catalogo'], ['GET', '/conta'], ['POST', '/intencoes'], ['POST', '/compras'], ['GET', '/intencoes/{id}']]) {
    for (const sub of [null, '', ' ', 123, ' alice']) assert.equal((await call(method, resource, {}, sub)).statusCode, 401);
  }
  assert.equal(provisioned.length, 0); assert.equal(store.snapshot().intents.length, 0);
});
test('API ignora identidade e preço no corpo e preserva contexto confiável', async () => {
  const { call, store, provisioned } = setup();
  const created = await call('POST', '/intencoes', { sku: 'MONITOR', quantidade: 1, usuario_id: 'bob', valor_total: 1 });
  assert.equal(created.statusCode, 201);
  const id = JSON.parse(created.body).intencao_id;
  assert.deepEqual(provisioned, ['alice']);
  assert.equal(store.snapshot().intents[0].userId, 'alice');
  assert.equal((await call('GET', '/intencoes/{id}', undefined, 'bob', id)).statusCode, 404);
  assert.equal(JSON.parse((await call('POST', '/compras', { intencao_id: id, metodo_pagamento: 'pix', usuario_id: 'alice' }, 'bob')).body).erro, 'INTENCAO_INVALIDA');
  const result = await call('POST', '/compras', { intencao_id: id, metodo_pagamento: 'pix', valor: 1 });
  assert.equal(JSON.parse(result.body).valor, 1899.9);
  assert.equal(result.headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:4173');
});
test('JSON inválido, corpo excessivo e quantidade inválida não criam intenção', async () => {
  const { handler, call, store } = setup();
  for (const body of ['{', 'x'.repeat(8193), 'null', '[]']) {
    const response = await handler({ httpMethod: 'POST', resource: '/intencoes', body, requestContext: { authorizer: { claims: { sub: 'alice' } } } });
    assert.equal(response.statusCode, 400);
  }
  assert.equal((await call('POST', '/intencoes', { sku: 'PS5', quantidade: 0 })).statusCode, 400);
  assert.equal(store.snapshot().intents.length, 0);
});
test('resposta de infraestrutura não expõe detalhes internos', async () => {
  const { store } = setup();
  const handler = createHttpHandler(Object.assign(store, {
    async ensureUser() { throw new Error('SEGREDO_INTERNO'); }, async getAccount() { return null; }, async getIntent() { return null; },
  }), 'http://127.0.0.1:4173');
  const result = await handler({ httpMethod: 'GET', resource: '/conta', requestContext: { authorizer: { claims: { sub: 'alice' } } } });
  assert.equal(result.statusCode, 503); assert.ok(!result.body.includes('SEGREDO_INTERNO'));
});
