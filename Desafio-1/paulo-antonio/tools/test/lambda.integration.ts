import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { fromIni } from '@aws-sdk/credential-providers';

const account = process.argv[process.argv.indexOf('--account') + 1];
if (!process.argv.includes('--account') || !/^\d{12}$/.test(account)) throw new Error('Informe --account CONTA.');
const profile = 'desafio-1';
const identity = JSON.parse(execFileSync('aws', ['sts', 'get-caller-identity', '--profile', profile, '--output', 'json'], { encoding: 'utf8' }));
assert.equal(identity.Account, account); assert.match(identity.Arn, /assumed-role\/AWSReservedSSO_/);
const userId = `integration-lambda-${randomUUID()}`;
const outputDir = resolve('../.deploy'); mkdirSync(outputDir, { recursive: true });
const output = resolve(outputDir, `${userId}.json`);
const ids: string[] = [];
const raw = new DynamoDBClient({ region: 'us-east-1', credentials: fromIni({ profile }) });
const db = DynamoDBDocumentClient.from(raw);
function invoke(method: string, resource: string, body?: unknown, sub: string | null = userId, id?: string) {
  // Direct administrative invocation with synthetic authorizer context: this tests
  // the Lambda IAM role and handler, NOT Cognito/API Gateway positive authentication.
  const event = { httpMethod: method, resource, requestContext: { authorizer: { claims: { sub } } },
    body: body === undefined ? null : JSON.stringify(body), pathParameters: id ? { id } : null };
  const meta = JSON.parse(execFileSync('aws', ['lambda', 'invoke', '--function-name', 'paulo-antonio-pagamentos-tools',
    '--profile', profile, '--region', 'us-east-1', '--cli-binary-format', 'raw-in-base64-out', '--payload', JSON.stringify(event), output, '--output', 'json'], { encoding: 'utf8' }));
  assert.equal(meta.FunctionError, undefined, 'Lambda retornou erro de execução');
  const result = JSON.parse(readFileSync(output, 'utf8'));
  return { status: result.statusCode, body: JSON.parse(result.body), headers: result.headers };
}
try {
  assert.equal(invoke('GET', '/conta', undefined, null).status, 401);
  const initial = invoke('GET', '/conta'); assert.equal(initial.status, 200); assert.equal(initial.body.limite_restante, 5000);
  assert.equal(invoke('GET', '/catalogo').body.count, 6);
  const created = invoke('POST', '/intencoes', { sku: 'MONITOR', quantidade: 1, usuario_id: 'intruso', valor_total: 1 });
  assert.equal(created.status, 201); ids.push(created.body.intencao_id);
  assert.equal(invoke('GET', '/intencoes/{id}', undefined, `${userId}-other`, ids[0]).status, 404);
  const paid = invoke('POST', '/compras', { intencao_id: ids[0], metodo_pagamento: 'pix' });
  assert.equal(paid.status, 200); assert.equal(paid.body.status, 'aprovado'); assert.equal(paid.body.valor, 1899.9);
  assert.equal(invoke('POST', '/compras', { intencao_id: ids[0], metodo_pagamento: 'pix' }).body.erro, 'INTENCAO_JA_PAGA');
  assert.equal(invoke('GET', '/intencoes/{id}', undefined, userId, ids[0]).body.status, 'paga');
  assert.equal(invoke('GET', '/conta').body.limite_restante, 3100.1);
  console.log('OK: Lambda real, permissões DynamoDB, provisionamento, catálogo, isolamento, Pix, consulta de estado e bloqueio de duplicidade.');
} finally {
  try {
    for (const id of ids) {
      await db.send(new DeleteCommand({ TableName: 'paulo-antonio-pagamentos-transacoes', Key: { id: `tx_${id}` } }));
      await db.send(new DeleteCommand({ TableName: 'paulo-antonio-pagamentos-intencoes', Key: { id } }));
    }
    await db.send(new DeleteCommand({ TableName: 'paulo-antonio-pagamentos-usuarios', Key: { userId } }));
    rmSync(output, { force: true });
    console.log('Fixtures e resposta temporária removidos.');
  } finally { raw.destroy(); }
}
