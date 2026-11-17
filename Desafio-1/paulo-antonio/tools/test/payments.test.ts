import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentTools, BadArgs } from '../src/payments.ts';
import type { Purchase } from '../src/payments.ts';
import { MemoryPaymentStore } from '../src/memory-store.ts';

const alice = { usuario_id: 'local-alice' };
const bob = { usuario_id: 'local-bob' };
function setup(limit = 500000) {
  let now = Date.parse('2026-11-15T12:00:00Z');
  const clock = () => now;
  const store = new MemoryPaymentStore([
    { usuario_id: alice.usuario_id, limite_centavos: limit },
    { usuario_id: bob.usuario_id, limite_centavos: 3000000 },
  ], clock);
  const tools = createPaymentTools(store, clock);
  const intent = (sku = 'PS5', quantidade = 1, context = alice) => tools.registrar_intencao({ sku, quantidade }, context);
  const buy = (id: string, method: unknown = 'pix', context: unknown = alice) => tools.realizar_compra({ intencao_id: id, metodo_pagamento: method }, context);
  return { store, tools, intent, buy, advance: (ms: number) => { now += ms; } };
}
function error(result: Purchase, code: string) {
  assert.equal(result.status, 'recusado');
  if (result.status === 'recusado') assert.equal(result.erro, code);
}

test('catálogo preserva seis produtos e filtro; retornos não alteram fonte de preços', () => {
  const { tools } = setup();
  const catalog = tools.listar_catalogo();
  assert.equal(catalog.count, 6);
  assert.equal(tools.listar_catalogo({ categoria: ' pc ' }).count, 3);
  assert.equal(catalog.items.find(i => i.sku === 'MONITOR')?.price, 1899.9);
  catalog.items[0].price = 1;
  assert.equal(tools.listar_catalogo().items[0].price, 4799);
  assert.throws(() => tools.listar_catalogo({ categoria: 'inexistente' }), BadArgs);
  assert.throws(() => tools.listar_catalogo({ categoria: 2 }), BadArgs);
});

test('intenção usa preço e identidade internos, UUID completo e validade de 180 segundos', async () => {
  const { tools, store } = setup();
  const result = await tools.registrar_intencao({ sku: ' monitor ', quantidade: 3,
    usuario_id: bob.usuario_id, valor_total: 1, intencao_id: 'inventado' }, alice);
  assert.equal(result.valor_total, 5699.7);
  assert.equal(result.expira_em, '2026-11-15T12:03:00.000Z');
  assert.match(result.intencao_id, /^int_[\da-f-]{36}$/);
  assert.equal(result.produto_id, 'MONITOR');
  assert.equal(result.status, 'pendente');
  assert.equal(store.snapshot().intents[0].userId, alice.usuario_id);
});

test('quantidade inválida, SKU desconhecido e overflow não criam intenção', async () => {
  const { tools, store } = setup();
  for (const quantity of [0, -1, 0.5, 1.9, NaN, Infinity, '1', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(tools.registrar_intencao({ sku: 'PS5', quantidade: quantity }, alice), BadArgs);
  }
  await assert.rejects(tools.registrar_intencao({ sku: 'LHC', quantidade: Number.MAX_SAFE_INTEGER }, alice), /intervalo/);
  await assert.rejects(tools.registrar_intencao({ sku: 'FAKE', quantidade: 1 }, alice), /SKU/);
  assert.equal(store.snapshot().intents.length, 0);
});

test('contexto ausente ou desconhecido nunca assume usuário de demonstração', async () => {
  const { tools, intent, buy, store } = setup();
  const item = await intent();
  for (const context of [undefined, null, {}, { usuario_id: '' }, { usuario_id: 123 }, { usuario_id: ' local-alice' }, { usuario_id: 'desconhecido' }]) {
    await assert.rejects(tools.registrar_intencao({ sku: 'PS5', quantidade: 1, usuario_id: alice.usuario_id }, context), BadArgs);
    error(await tools.realizar_compra({ intencao_id: item.intencao_id, metodo_pagamento: 'pix' }, context), 'INTENCAO_INVALIDA');
  }
  assert.equal(store.snapshot().transactions.length, 0);
});

for (const method of ['cartao', 'pix']) {
  test(`compra com ${method} debita limite e registra intenção e transação`, async () => {
    const { intent, buy, store } = setup();
    const item = await intent();
    const result = await buy(item.intencao_id, method);
    assert.equal(result.status, 'aprovado');
    if (result.status !== 'aprovado') return;
    assert.equal(result.valor, 4799);
    assert.equal(result.limite_restante, 201);
    assert.equal(result.metodo_pagamento, method);
    assert.equal(store.snapshot().intents[0].status, 'paga');
    assert.equal(store.snapshot().users[0][1].spent, 479900);
    assert.equal(store.snapshot().transactions.length, 1);
    result.valor = 0;
    assert.equal(store.snapshot().transactions[0].valor, 4799);
  });
}

test('intenção inexistente e de outro usuário têm a mesma recusa e não alteram saldo', async () => {
  const { intent, buy, store } = setup();
  const item = await intent();
  const before = store.snapshot();
  assert.deepEqual(await buy('inventada', 'pix', bob), await buy(item.intencao_id, 'pix', bob));
  error(await buy('', 'pix'), 'INTENCAO_INVALIDA');
  assert.deepEqual(store.snapshot(), before);
});

test('argumentos do modelo não podem trocar titular nem reduzir preço', async () => {
  const { intent, tools } = setup();
  const item = await intent();
  error(await tools.realizar_compra({ intencao_id: item.intencao_id, metodo_pagamento: 'pix', usuario_id: alice.usuario_id }, bob), 'INTENCAO_INVALIDA');
  const result = await tools.realizar_compra({ intencao_id: item.intencao_id, metodo_pagamento: 'pix', valor: 0, usuario_id: bob.usuario_id }, alice);
  assert.equal(result.status, 'aprovado');
  if (result.status === 'aprovado') assert.equal(result.valor, 4799);
});

test('método inválido recusa sem efeitos e permite nova tentativa válida', async () => {
  const { intent, buy, store, tools } = setup();
  const item = await intent();
  const before = store.snapshot();
  for (const method of ['boleto', '', null, 1, undefined]) error(await tools.realizar_compra({ intencao_id: item.intencao_id, metodo_pagamento: method }, alice), 'METODO_INVALIDO');
  assert.deepEqual(store.snapshot(), before);
  assert.equal((await buy(item.intencao_id, ' PIX ')).status, 'aprovado');
});

test('expiração no instante exato de 180s; antes desse instante ainda é válida', async () => {
  const first = setup();
  const a = await first.intent();
  first.advance(179999);
  assert.equal((await first.buy(a.intencao_id)).status, 'aprovado');
  const second = setup();
  const b = await second.intent();
  second.advance(180000);
  const before = second.store.snapshot();
  error(await second.buy(b.intencao_id), 'INTENCAO_EXPIRADA');
  assert.deepEqual(second.store.snapshot(), before);
});

test('limite exato aprova, um centavo abaixo recusa; conta não é alterada na recusa', async () => {
  const exact = setup(189990);
  const a = await exact.intent('MONITOR');
  const approved = await exact.buy(a.intencao_id);
  assert.equal(approved.status, 'aprovado');
  if (approved.status === 'aprovado') assert.equal(approved.limite_restante, 0);
  const short = setup(189989);
  const b = await short.intent('MONITOR');
  const before = short.store.snapshot();
  error(await short.buy(b.intencao_id), 'LIMITE_EXCEDIDO');
  assert.deepEqual(short.store.snapshot(), before);
});

test('vinte chamadas simultâneas da mesma intenção geram só um débito no processo local', async () => {
  const { intent, buy, store, advance } = setup();
  const item = await intent();
  const results = await Promise.all(Array.from({ length: 20 }, () => buy(item.intencao_id)));
  assert.equal(results.filter(r => r.status === 'aprovado').length, 1);
  for (const result of results.filter(r => r.status !== 'aprovado')) error(result, 'INTENCAO_JA_PAGA');
  advance(180000);
  error(await buy(item.intencao_id), 'INTENCAO_JA_PAGA');
  assert.equal(store.snapshot().transactions.length, 1);
  assert.equal(store.snapshot().users[0][1].spent, 479900);
});

test('intenções concorrentes compartilham limite e somam centavos sem arredondamento', async () => {
  const { intent, buy, store } = setup(379980);
  const items = await Promise.all(Array.from({ length: 3 }, () => intent('MONITOR')));
  const results = await Promise.all(items.map(i => buy(i.intencao_id)));
  assert.equal(results.filter(r => r.status === 'aprovado').length, 2);
  error(results.find(r => r.status === 'recusado')!, 'LIMITE_EXCEDIDO');
  assert.equal(store.snapshot().users[0][1].spent, 379980);
  assert.equal(store.snapshot().transactions.length, 2);
});
