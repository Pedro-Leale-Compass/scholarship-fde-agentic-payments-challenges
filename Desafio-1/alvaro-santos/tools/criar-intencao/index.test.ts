import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { createHandler, DynamoPutClient } from './index';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('TOOL-02: criar-intencao de compra', () => {
  it('grava intenção PENDENTE no DynamoDB com valor calculado pelo catálogo e TTL de 15 minutos', async () => {
    process.env.INTENCOES_TABLE_NAME = 'alvaro-intencoes';
    let capturedCommand: PutCommand | undefined;

    const fakeClient: DynamoPutClient = {
      async send(command: PutCommand) {
        capturedCommand = command;
        return {};
      },
    };

    const fixedNowMs = 1_700_000_000_000; // 1.700.000.000s
    const run = createHandler(fakeClient, () => fixedNowMs);

    const response = await run({
      usuario_id: 'sub-user-123',
      produto_id: 'prod_004', // Mouse Gamer Wireless 26000 DPI: 249.90
      quantidade: 2,
    });

    assert.equal(capturedCommand?.input.TableName, 'alvaro-intencoes');
    assert.equal(capturedCommand?.input.ConditionExpression, 'attribute_not_exists(intencao_id)');

    const savedItem = capturedCommand?.input.Item as Record<string, unknown>;
    assert.match(String(savedItem.intencao_id), UUID_V4_REGEX);
    assert.equal(savedItem.usuario_id, 'sub-user-123');
    assert.equal(savedItem.produto_id, 'prod_004');
    assert.equal(savedItem.quantidade, 2);
    assert.equal(savedItem.valor_total, 499.8);
    assert.equal(savedItem.status, 'PENDENTE');
    assert.equal(savedItem.expires_at, 1_700_000_000 + 900);

    assert.equal(response.intencao_id, savedItem.intencao_id);
    assert.equal(response.valor_total, 499.8);
    assert.equal(response.status, 'PENDENTE');
    assert.equal(response.moeda, 'BRL');
    assert.ok(response.mensagem.includes('pix ou cartao'));
  });

  it('rejeita produto inexistente sem tocar no DynamoDB', async () => {
    process.env.INTENCOES_TABLE_NAME = 'alvaro-intencoes';
    const fakeClient: DynamoPutClient = {
      async send() {
        throw new Error('Não deveria gravar intenção para produto inexistente');
      },
    };

    const run = createHandler(fakeClient);
    await assert.rejects(
      () => run({ usuario_id: 'sub-user-123', produto_id: 'prod_999', quantidade: 1 }),
      /Produto não encontrado/,
    );
  });

  it('rejeita quantidade inválida ou acima do estoque disponível', async () => {
    process.env.INTENCOES_TABLE_NAME = 'alvaro-intencoes';
    const fakeClient: DynamoPutClient = {
      async send() {
        throw new Error('Não deveria gravar intenção para quantidade inválida');
      },
    };

    const run = createHandler(fakeClient);
    await assert.rejects(
      () => run({ usuario_id: 'sub-user-123', produto_id: 'prod_001', quantidade: 0 }),
      /quantidade/,
    );
    await assert.rejects(
      () => run({ usuario_id: 'sub-user-123', produto_id: 'prod_001', quantidade: 1.5 }),
      /quantidade/,
    );
    await assert.rejects(
      () => run({ usuario_id: 'sub-user-123', produto_id: 'prod_001', quantidade: 999 }),
      /Estoque insuficiente/,
    );
  });

  it('falha explicitamente quando usuario_id não é fornecido', async () => {
    process.env.INTENCOES_TABLE_NAME = 'alvaro-intencoes';
    const fakeClient: DynamoPutClient = {
      async send() {
        throw new Error('Não deveria gravar intenção sem usuario_id');
      },
    };

    const run = createHandler(fakeClient);
    await assert.rejects(
      () => run({ produto_id: 'prod_001', quantidade: 1 }),
      /usuario_id/,
    );
  });
});
