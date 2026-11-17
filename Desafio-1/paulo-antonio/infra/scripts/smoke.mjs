import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stacks = Object.values(JSON.parse(readFileSync(resolve(project, '.deploy/outputs.json'), 'utf8')));
assert.equal(stacks.length, 1, 'Esperada uma única stack no arquivo de outputs.');
const output = stacks[0];
const site = new URL(output.FrontendUrl);
const api = new URL(output.ApiUrl);
const backendOnly = process.argv.includes('--backend');
if (backendOnly) assert.equal(site.origin, 'http://127.0.0.1:4173');
else assert.equal(site.protocol, 'https:');
assert.equal(api.protocol, 'https:');
const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) });

if (!backendOnly) {
assert.equal((await request(site)).status, 200, 'Interface deve responder 200.');
const configResponse = await request(new URL('/config.json', site));
assert.equal(configResponse.status, 200);
const config = await configResponse.json();
assert.equal(config.userPoolId, output.UserPoolId);
assert.equal(config.userPoolClientId, output.UserPoolClientId);
assert.equal(config.apiUrl, output.ApiUrl);
}

for (const [path, method] of [['sessao', 'GET'], ['catalogo', 'GET'], ['conta', 'GET'], ['intencoes', 'POST'], ['compras', 'POST'], ['intencoes/inexistente', 'GET'], ['chat', 'POST'], ['conversas', 'GET']]) {
for (const authorization of [undefined, 'Bearer invalid-token']) {
  const response = await request(new URL(path, api), {
    method,
    headers: { Origin: site.origin, ...(authorization ? { Authorization: authorization } : {}) },
  });
  assert.equal(response.status, 401, `${method} ${path}: API deve rejeitar ausência de token e token inválido.`);
  assert.equal(response.headers.get('access-control-allow-origin'), site.origin);
  await new Promise(resolve => setTimeout(resolve, 250));
}
}
const preflight = await request(new URL('sessao', api), { method: 'OPTIONS', headers: {
  Origin: site.origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization',
} });
assert.equal(preflight.status, 204);
assert.equal(preflight.headers.get('access-control-allow-origin'), site.origin);
if (backendOnly) {
  console.log('OK: API rejeita token ausente/inválido com 401; preflight e CORS restritos à interface local. Login real ainda deve ser validado.');
  process.exit(0);
}
const bucket = output.FrontendBucketName;
assert.match(bucket, /^[a-z0-9-]+$/);
const direct = await request(`https://${bucket}.s3.us-east-1.amazonaws.com/index.html`);
assert.equal(direct.status, 403, 'Bucket deve recusar acesso público direto.');
console.log('OK: interface, configuração, rejeição 401 e bucket privado. Login/convite e token expirado requerem validação adicional.');
