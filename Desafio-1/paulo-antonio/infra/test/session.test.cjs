const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handler } = require('../build/api/session.js');
process.env.FRONTEND_ORIGIN = 'https://teste.cloudfront.net';

test('sessão usa claims do autorizador e ignora identidade do corpo', async () => {
  const result = await handler({
    requestContext: { authorizer: { claims: { sub: 'usuario-confiavel' } } },
    body: JSON.stringify({ usuario_id: 'outro-usuario' }),
    headers: { origin: 'https://outra-origem.example' },
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { usuario_id: 'usuario-confiavel', autenticado: true });
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers['Access-Control-Allow-Origin'], process.env.FRONTEND_ORIGIN);
});

test('sem claims válidas não há fallback para usuário demo', async () => {
  for (const sub of [undefined, null, '', ' ', 123, { id: 'forjado' }]) {
    const result = await handler({
      requestContext: { authorizer: { claims: { sub } } },
      body: JSON.stringify({ usuario_id: 'demo' }),
    });
    assert.equal(result.statusCode, 401);
  }
  assert.equal((await handler({ requestContext: {} })).statusCode, 401);
});
