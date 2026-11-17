/**
 * Testes de validação do agente e das tools.
 *
 * Não dependem do Postman: criam um usuário temporário no Cognito, exercitam a API
 * implantada e conferem o estado real no DynamoDB. O usuário e seus dados são
 * removidos ao final de cada teste.
 *
 * Requisitos: stack implantada (infra/cdk-outputs.json) e credenciais AWS válidas.
 * Execução: npm run test:agent
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REGION = process.env.AWS_REGION || 'us-east-1';
const PROFILE = process.env.AWS_PROFILE || 'desafio-1';
const OUTPUTS_FILE = join(ROOT, 'infra', 'cdk-outputs.json');

if (!existsSync(OUTPUTS_FILE)) {
  throw new Error(
    `cdk-outputs.json não encontrado. Rode npm run deploy:api-agent primeiro.`,
  );
}

const outputs = JSON.parse(readFileSync(OUTPUTS_FILE, 'utf8')).Desafio1Stack;
const API_URL = String(outputs.ApiUrl || '').replace(/\/$/, '');
const CLIENT_ID = outputs.CognitoUserPoolClientId;
const POOL_ID = outputs.CognitoUserPoolId;
const USUARIOS_TABLE = outputs.UsuariosTableName || 'luiz-henrique-usuarios';
const INTOCOES_TABLE = process.env.INTENCOES_TABLE || 'luiz-henrique-intencoes';
const REALIZAR_COMPRA_FN =
  process.env.TOOL_REALIZAR_COMPRA || 'luiz-henrique-realizar-compra';

const tmpDir = mkdtempSync(join(tmpdir(), 'desafio1-test-'));
let seq = 0;

function awsJson(service, operation, input) {
  const inputFile = join(tmpDir, `in-${seq++}.json`);
  writeFileSync(inputFile, JSON.stringify(input));
  const out = execFileSync(
    'aws',
    [
      service,
      operation,
      '--region',
      REGION,
      '--profile',
      PROFILE,
      '--cli-input-json',
      `file://${inputFile}`,
      '--output',
      'json',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return out.trim() ? JSON.parse(out) : {};
}

function invokeTool(payload) {
  const payloadFile = join(tmpDir, `payload-${seq++}.json`);
  const outFile = join(tmpDir, `out-${seq++}.json`);
  writeFileSync(payloadFile, JSON.stringify(payload));
  execFileSync(
    'aws',
    [
      'lambda',
      'invoke',
      '--region',
      REGION,
      '--profile',
      PROFILE,
      '--function-name',
      REALIZAR_COMPRA_FN,
      '--payload',
      `fileb://${payloadFile}`,
      '--cli-binary-format',
      'raw-in-base64-out',
      outFile,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(readFileSync(outFile, 'utf8'));
}

const S = (v) => ({ S: String(v) });
const N = (v) => ({ N: String(v) });

async function login(email, password) {
  const res = awsJson('cognito-idp', 'initiate-auth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: CLIENT_ID,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });
  const token = res.AuthenticationResult?.IdToken;
  assert.ok(token, 'login no Cognito não retornou IdToken');
  return token;
}

async function chat(token, messages) {
  const res = await fetch(`${API_URL}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ messages }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function createUser(limitCentavos) {
  const email = `agent-test-${Date.now()}-${randomUUID().slice(0, 6)}@example.com`;
  const password = `Aa1!${randomUUID()}`;

  awsJson('cognito-idp', 'admin-create-user', {
    UserPoolId: POOL_ID,
    Username: email,
    UserAttributes: [
      { Name: 'email', Value: email },
      { Name: 'email_verified', Value: 'true' },
    ],
    MessageAction: 'SUPPRESS',
  });
  awsJson('cognito-idp', 'admin-set-user-password', {
    UserPoolId: POOL_ID,
    Username: email,
    Password: password,
    Permanent: true,
  });

  const user = awsJson('cognito-idp', 'admin-get-user', { UserPoolId: POOL_ID, Username: email });
  const sub = user.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
  assert.ok(sub, 'usuário de teste sem sub');

  const now = new Date().toISOString();
  awsJson('dynamodb', 'put-item', {
    TableName: USUARIOS_TABLE,
    Item: {
      usuario_id: S(sub),
      email: S(email),
      limite_centavos: N(limitCentavos),
      gasto_total_centavos: N(0),
      status: S('ativo'),
      origem: S('manual'),
      criado_em: S(now),
      atualizado_em: S(now),
    },
  });

  const cleanup = async () => {
    try {
      const intentions = awsJson('dynamodb', 'query', {
        TableName: INTOCOES_TABLE,
        IndexName: 'usuario_id-index',
        KeyConditionExpression: 'usuario_id = :u',
        ExpressionAttributeValues: { ':u': S(sub) },
      });
      for (const item of intentions.Items || []) {
        awsJson('dynamodb', 'delete-item', {
          TableName: INTOCOES_TABLE,
          Key: { intencao_id: item.intencao_id },
        });
      }
      // Intenção criada para um usuário fictício no teste de ownership.
      awsJson('dynamodb', 'delete-item', {
        TableName: INTOCOES_TABLE,
        Key: { intencao_id: S('test-txn-outro-dono') },
      });
      awsJson('dynamodb', 'delete-item', {
        TableName: USUARIOS_TABLE,
        Key: { usuario_id: S(sub) },
      });
    } catch {
      // cleanup best-effort
    }
    try {
      awsJson('cognito-idp', 'admin-delete-user', {
        UserPoolId: POOL_ID,
        Username: email,
      });
    } catch {
      // usuário já removido
    }
  };

  return { email, password, sub, cleanup };
}

async function getUsuario(sub) {
  return awsJson('dynamodb', 'get-item', {
    TableName: USUARIOS_TABLE,
    Key: { usuario_id: S(sub) },
  }).Item;
}

async function getIntencoes(sub) {
  return (
    awsJson('dynamodb', 'query', {
      TableName: INTOCOES_TABLE,
      IndexName: 'usuario_id-index',
      KeyConditionExpression: 'usuario_id = :u',
      ExpressionAttributeValues: { ':u': S(sub) },
    }).Items || []
  );
}

async function getIntencao(intencaoId) {
  return awsJson('dynamodb', 'get-item', {
    TableName: INTOCOES_TABLE,
    Key: { intencao_id: S(intencaoId) },
  }).Item;
}

async function putIntencao({
  intencaoId,
  usuarioId,
  valor,
  valorCentavos,
  expiraEm,
  status = 'pendente',
}) {
  await awsJson('dynamodb', 'put-item', {
    TableName: INTOCOES_TABLE,
    Item: {
      intencao_id: S(intencaoId),
      usuario_id: S(usuarioId),
      valor: N(valor),
      valor_centavos: N(valorCentavos),
      status: S(status),
      expira_em: S(expiraEm),
      created_at: S(new Date().toISOString()),
    },
  });
}

const future = (minutes = 15) =>
  new Date(Date.now() + minutes * 60 * 1000).toISOString();
const past = (minutes = 5) =>
  new Date(Date.now() - minutes * 60 * 1000).toISOString();

const UUID_IN_REPLY =
  /\b(?:INT-[0-9A-F]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

const SUCCESS_REPLY =
  /(compra\s+(?:foi\s+)?(?:realizada|confirmada|aprovada|conclu[ií]da|finalizada|efetuada)|pagamento\s+(?:aprovado|confirmado|realizado)|compra\s+aprovada)/i;

test('POST /chat sem token responde 401', async () => {
  const res = await fetch(`${API_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(res.status, 401);
});

test('realizar_compra: saldo, idempotência e códigos de erro', async () => {
  const user = await createUser(10000);
  try {
    await putIntencao({
      intencaoId: 'test-txn-ok',
      usuarioId: user.sub,
      valor: 50,
      valorCentavos: 5000,
      expiraEm: future(),
    });

    const ok = invokeTool({
      usuario_id: user.sub,
      intencao_id: 'test-txn-ok',
      forma_pagamento: 'cartao',
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(JSON.parse(ok.body).code, 'COMPRA_APROVADA');

    const debitado = await getUsuario(user.sub);
    assert.equal(Number(debitado.limite_centavos.N), 5000);
    assert.equal(Number(debitado.gasto_total_centavos.N), 5000);

    const retry = invokeTool({
      usuario_id: user.sub,
      intencao_id: 'test-txn-ok',
      forma_pagamento: 'cartao',
    });
    assert.equal(retry.statusCode, 409);
    assert.equal(JSON.parse(retry.body).code, 'INTENCAO_JA_PAGA');

    await putIntencao({
      intencaoId: 'test-txn-limit',
      usuarioId: user.sub,
      valor: 100,
      valorCentavos: 10000,
      expiraEm: future(),
    });
    const limite = invokeTool({
      usuario_id: user.sub,
      intencao_id: 'test-txn-limit',
      forma_pagamento: 'pix',
    });
    assert.equal(limite.statusCode, 422);
    assert.equal(JSON.parse(limite.body).code, 'LIMITE_EXCEDIDO');
    assert.equal((await getIntencao('test-txn-limit')).status.S, 'cancelada');

    const invalida = invokeTool({
      usuario_id: user.sub,
      intencao_id: 'nao-existe',
      forma_pagamento: 'pix',
    });
    assert.equal(invalida.statusCode, 404);
    assert.equal(JSON.parse(invalida.body).code, 'INTENCAO_INVALIDA');

    await putIntencao({
      intencaoId: 'test-txn-outro-dono',
      usuarioId: 'outro-usuario',
      valor: 10,
      valorCentavos: 1000,
      expiraEm: future(),
    });
    const outro = invokeTool({
      usuario_id: user.sub,
      intencao_id: 'test-txn-outro-dono',
      forma_pagamento: 'pix',
    });
    assert.equal(outro.statusCode, 404);
    assert.equal(JSON.parse(outro.body).code, 'INTENCAO_INVALIDA');

    await putIntencao({
      intencaoId: 'test-txn-expirada',
      usuarioId: user.sub,
      valor: 10,
      valorCentavos: 1000,
      expiraEm: past(),
    });
    const expirada = invokeTool({
      usuario_id: user.sub,
      intencao_id: 'test-txn-expirada',
      forma_pagamento: 'pix',
    });
    assert.equal(expirada.statusCode, 410);
    assert.equal(JSON.parse(expirada.body).code, 'INTENCAO_EXPIRADA');
    assert.equal((await getIntencao('test-txn-expirada')).status.S, 'cancelada');

    const metodo = invokeTool({
      usuario_id: user.sub,
      intencao_id: 'test-txn-outro-dono',
      forma_pagamento: 'boleto',
    });
    assert.equal(metodo.statusCode, 400);
    assert.equal(JSON.parse(metodo.body).code, 'METODO_INVALIDO');
  } finally {
    await user.cleanup();
  }
});

test('agente não confirma compra enquanto a intenção está pendente', async () => {
  const user = await createUser(100000);
  let token;
  try {
    token = await login(user.email, user.password);

    const history = [];
    const say = async (text) => {
      history.push({ role: 'user', content: [{ text }] });
      const res = await chat(token, history);
      const reply =
        res.json?.reply ?? res.json?.message ?? JSON.stringify(res.json);
      assert.doesNotMatch(
        reply,
        /^\s*(?:user|assistant|human|ai|system)\s*:/im,
        `a resposta contém turno fabricado: ${reply}`,
      );
      const ids = reply.match(UUID_IN_REPLY) || [];
      for (const id of ids) {
        assert.ok(
          await getIntencao(id),
          `intencao_id inventado na resposta: ${id}\n${reply}`,
        );
      }
      history.push({ role: 'assistant', content: [{ text: reply }] });
      return { status: res.status, reply };
    };

    // 1ª compra: registrar intenção pendente.
    const primeiro = await say(
      'Quero comprar o Fone Bluetooth. Apenas registre a intenção; não finalize a compra.',
    );
    assert.equal(primeiro.status, 200, primeiro.reply);
    assert.doesNotMatch(
      primeiro.reply,
      SUCCESS_REPLY,
      `o agente afirmou compra paga com a intenção ainda pendente: ${primeiro.reply}`,
    );

    const intencoes = await getIntencoes(user.sub);
    assert.equal(intencoes.length, 1, JSON.stringify(intencoes));
    const intencao = intencoes[0];
    assert.equal(intencao.status.S, 'pendente');

    const intencaoId = intencao.intencao_id.S;
    assert.ok(
      primeiro.reply.includes(intencaoId),
      `o agente não informou o intencao_id (${intencaoId}): ${primeiro.reply}`,
    );

    // 1º pagamento.
    const segundo = await say('Pode confirmar o pagamento com cartão.');
    assert.equal(segundo.status, 200, segundo.reply);

    const intencaoPaga = (await getIntencoes(user.sub)).find(
      (i) => i.intencao_id.S === intencaoId,
    );
    assert.ok(intencaoPaga, 'intenção desapareceu');
    assert.equal(intencaoPaga.status.S, 'paga', segundo.reply);
    assert.equal(intencaoPaga.forma_pagamento.S, 'cartao');

    const usuario = await getUsuario(user.sub);
    const valorCentavos = Number(intencao.valor_centavos.N);
    assert.equal(
      Number(usuario.limite_centavos.N),
      100000 - valorCentavos,
    );
    assert.equal(Number(usuario.gasto_total_centavos.N), valorCentavos);
    assert.match(
      segundo.reply,
      SUCCESS_REPLY,
      `compra paga mas a resposta não confirmou: ${segundo.reply}`,
    );

    // 2ª compra após uma compra confirmada (regressão da mensagem genérica).
    const terceiro = await say('Quero comprar o Teclado Mecânico.');
    assert.equal(terceiro.status, 200, terceiro.reply);
    assert.doesNotMatch(
      terceiro.reply,
      SUCCESS_REPLY,
      `o agente afirmou compra paga antes do pagamento: ${terceiro.reply}`,
    );
    assert.doesNotMatch(
      terceiro.reply,
      /A compra ainda não foi finalizada/,
      `o agente usou a mensagem de guard antes de tentar pagar: ${terceiro.reply}`,
    );

    const teclado = (await getIntencoes(user.sub)).find(
      (i) => i.status?.S === 'pendente',
    );
    assert.ok(teclado, `intenção do teclado não ficou pendente: ${JSON.stringify(await getIntencoes(user.sub))}`);
    const tecladoId = teclado.intencao_id.S;

    const quarto = await say('Pix.');
    assert.equal(quarto.status, 200, quarto.reply);
    assert.doesNotMatch(
      quarto.reply,
      /A compra ainda não foi finalizada/,
      `a segunda compra não foi finalizada: ${quarto.reply}`,
    );
    const tecladoPago = (await getIntencoes(user.sub)).find(
      (i) => i.intencao_id.S === tecladoId,
    );
    assert.equal(tecladoPago.status.S, 'paga', quarto.reply);
    assert.equal(tecladoPago.forma_pagamento.S, 'pix');

    const usuario2 = await getUsuario(user.sub);
    assert.equal(
      Number(usuario2.limite_centavos.N),
      100000 - valorCentavos - Number(teclado.valor_centavos.N),
    );

    // Compra acima do limite: não pode ser narrada como aprovada.
    const quinto = await say('Quero comprar a Cadeira Gamer.');
    assert.equal(quinto.status, 200, quinto.reply);
    assert.doesNotMatch(
      quinto.reply,
      SUCCESS_REPLY,
      `o agente afirmou compra paga antes do pagamento: ${quinto.reply}`,
    );

    const sexto = await say('Pode confirmar o pagamento com cartão.');
    assert.equal(sexto.status, 200, sexto.reply);
    assert.match(
      sexto.reply,
      /limite|saldo/i,
      `compra acima do limite sem explicar o motivo: ${sexto.reply}`,
    );
    assert.doesNotMatch(
      sexto.reply,
      SUCCESS_REPLY,
      `o agente afirmou compra paga acima do limite: ${sexto.reply}`,
    );

    const pagas = (await getIntencoes(user.sub)).filter(
      (i) => i.status?.S === 'paga',
    );
    assert.equal(pagas.length, 2, JSON.stringify(pagas));

    const canceladas = (await getIntencoes(user.sub)).filter(
      (i) => i.status?.S === 'cancelada',
    );
    assert.ok(
      canceladas.length >= 1,
      `intenção acima do limite deveria ser cancelada: ${JSON.stringify(canceladas)}`,
    );
  } finally {
    await user.cleanup();
  }
});