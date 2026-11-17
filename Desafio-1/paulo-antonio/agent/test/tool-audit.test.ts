import test from 'node:test';
import assert from 'node:assert/strict';
import { auditTools } from '../src/tool-audit.ts';

test('audit correlates calls without exposing inputs, outputs or errors', async () => {
  const lines: string[] = [];
  const secret = 'PRIVATE_DATA_MUST_NOT_APPEAR';
  const value = { erro: secret, mensagem: secret };
  const failure = new Error(secret);
  let fail = false;
  const deps = auditTools({ infer: async () => ({ role: 'assistant', content: [] }),
    invoke: async () => { if (fail) throw failure; return value; } }, line => lines.push(line));
  assert.equal(await deps.invoke(secret, 'POST', '/compras', { secret }, secret), value);
  fail = true;
  await assert.rejects(deps.invoke(secret, 'GET', '/conta'), error => error === failure);
  assert.equal(lines.length, 4);
  assert.ok(!lines.join('').includes(secret));
  const records = lines.map(line => JSON.parse(line));
  assert.equal(records[0].callId, records[1].callId);
  assert.equal(records[2].callId, records[3].callId);
  assert.notEqual(records[0].callId, records[2].callId);
  assert.equal(records[0].invocationId, records[2].invocationId);
  assert.equal(records[1].result, 'refused');
  assert.equal(records[3].result, 'error');
  assert.equal(records[0].operation, 'realizar_compra');
});
