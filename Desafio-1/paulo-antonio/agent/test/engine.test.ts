import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/engine.ts';
import type { Message } from '@aws-sdk/client-bedrock-runtime';
const initial: Message[] = [{ role: 'user', content: [{ text: 'Compre um monitor por pix.' }] }];
const tool = (name: string, input: any): Message => ({ role: 'assistant', content: [{ toolUse: { name, input, toolUseId: 'tool1' } }] });
const final: Message = { role: 'assistant', content: [{ text: 'Confira a compra.' }] };
test('pedido do modelo nunca debita; identidade e preço vêm do servidor', async () => {
  let step = 0; const calls: any[] = []; const events: any[] = [];
  await runAgent({ userId: 'owner', messages: initial }, {
    infer: async () => step++ ? final : tool('realizar_compra', { intencao_id: 'int1', metodo_pagamento: 'pix', usuario_id: 'victim', valor_total: 1 }),
    invoke: async (...args) => { calls.push(args); return { intencao_id: 'int1', status: 'pendente', valor_total: 1899.9, produto_id: 'MONITOR', quantidade: 1 }; },
  }, event => events.push(structuredClone(event)));
  assert.deepEqual(calls, [['owner', 'GET', '/intencoes/{id}', undefined, 'int1']]);
  assert.equal(events.at(-1).pending.valor_total, 1899.9);
  assert.equal(events.at(-1).messages.length, 4);
  assert.equal(initial.length, 1);
});
test('confirmação confiável executa uma vez e não autoriza nova compra pedida pelo modelo', async () => {
  const calls: any[] = []; let step = 0;
  await runAgent({ userId: 'owner', messages: initial, confirmation: { intencao_id: 'int1', metodo_pagamento: 'pix', valor_total: 1899.9, produto_id: 'MONITOR', quantidade: 1 } }, {
    infer: async messages => { assert.ok(messages.length >= 3); return step++ ? final : tool('realizar_compra', { intencao_id: 'int1', metodo_pagamento: 'pix' }); },
    invoke: async (...args) => { calls.push(args); return args[1] === 'POST' ? { status: 'aprovado' } : { status: 'paga' }; },
  }, () => {});
  assert.equal(calls.filter(c => c[1] === 'POST').length, 1);
  assert.deepEqual(calls[0], ['owner', 'POST', '/compras', { intencao_id: 'int1', metodo_pagamento: 'pix' }]);
});
test('intenção expirada ou alheia não produz botão de confirmação', async () => {
  for (const intent of [{ status: 'pendente', expirada: true, valor_total: 20 }, { erro: 'SOLICITACAO_RECUSADA' }]) {
    let step = 0; let last: any;
    await runAgent({ userId: 'owner', messages: initial }, { infer: async () => step++ ? final : tool('realizar_compra', { intencao_id: 'int1', metodo_pagamento: 'pix' }), invoke: async () => intent }, event => { last = event; });
    assert.equal(last.pending, null);
  }
});
test('falha ambígua na compra não repete a chamada', async () => {
  let calls = 0;
  await assert.rejects(runAgent({ userId: 'owner', messages: initial, confirmation: { intencao_id: 'int1', metodo_pagamento: 'pix', valor_total: 10, produto_id: 'X', quantidade: 1 } }, {
    infer: async () => final, invoke: async () => { calls++; throw new Error('network'); },
  }, () => {}));
  assert.equal(calls, 1);
});
test('limite de rodadas impede loop de ferramentas', async () => {
  let calls = 0;
  await assert.rejects(runAgent({ userId: 'owner', messages: initial }, { infer: async () => tool('consultar_limite', {}), invoke: async () => { calls++; return {}; } }, () => {}), /Limite/);
  assert.equal(calls, 6);
});
