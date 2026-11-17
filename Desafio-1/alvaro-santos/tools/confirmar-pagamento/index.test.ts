import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createHandler, DynamoPaymentClient } from './index';

function setEnvTables() {
  process.env.INTENCOES_TABLE_NAME = 'alvaro-intencoes';
  process.env.USUARIOS_TABLE_NAME = 'alvaro-usuarios';
}

describe('TOOL-03: confirmar-pagamento com escrita condicional atômica', () => {
  it('liquida intenção PENDENTE via TransactWriteCommand e retorna comprovante aprovado com limite restante', async () => {
    setEnvTables();
    const fixedNowMs = 1_700_000_000_000;
    const nowSec = Math.floor(fixedNowMs / 1000);
    let capturedTransact: TransactWriteCommand | undefined;

    const fakeClient: DynamoPaymentClient = {
      async send(command: GetCommand | TransactWriteCommand) {
        if (command instanceof GetCommand) {
          if (command.input.TableName === 'alvaro-intencoes') {
            return {
              Item: {
                intencao_id: 'int-123',
                usuario_id: 'sub-user-1',
                valor_total: 499.8,
                status: 'PENDENTE',
                expires_at: nowSec + 600,
              },
            };
          }
          return {
            Item: {
              usuario_id: 'sub-user-1',
              saldo_disponivel: 1500.2,
            },
          };
        }
        capturedTransact = command;
        return {};
      },
    };

    const run = createHandler(fakeClient, () => fixedNowMs);
    const result = await run({
      usuario_id: 'sub-user-1',
      intencao_id: 'int-123',
      metodo_pagamento: 'PIX',
    });

    assert.equal(result.status, 'aprovado');
    if (result.status !== 'aprovado') return;

    assert.match(result.transacao_id, /^tx_/);
    assert.equal(result.intencao_id, 'int-123');
    assert.equal(result.valor, 499.8);
    assert.equal(result.metodo_pagamento, 'pix');
    assert.equal(result.limite_restante, 1500.2);

    const items = capturedTransact?.input.TransactItems;
    assert.equal(items?.length, 2);
    assert.equal(items?.[0]?.Update?.TableName, 'alvaro-intencoes');
    assert.ok(items?.[0]?.Update?.ConditionExpression?.includes('#status = :pendente'));
    assert.equal(items?.[1]?.Update?.TableName, 'alvaro-usuarios');
    assert.ok(items?.[1]?.Update?.ConditionExpression?.includes('saldo_disponivel >= :valor'));
    assert.equal(items?.[1]?.Update?.ExpressionAttributeValues?.[':valor'], 499.8);
  });

  it('rejeita com METODO_INVALIDO quando metodo_pagamento não é pix nem cartao', async () => {
    setEnvTables();
    const fakeClient: DynamoPaymentClient = {
      async send() {
        throw new Error('Não deveria acessar DynamoDB para método inválido');
      },
    };

    const run = createHandler(fakeClient);
    const result = await run({
      usuario_id: 'sub-user-1',
      intencao_id: 'int-123',
      metodo_pagamento: 'boleto',
    });

    assert.equal(result.status, 'recusado');
    if (result.status !== 'recusado') return;
    assert.equal(result.erro, 'METODO_INVALIDO');
    assert.equal(result.codigo, 'METODO_INVALIDO');
  });

  it('rejeita com INTENCAO_INVALIDA quando intenção não existe ou pertence a outro usuário', async () => {
    setEnvTables();
    const fakeClientInexistente: DynamoPaymentClient = {
      async send() {
        return {};
      },
    };
    const fakeClientOutroUsuario: DynamoPaymentClient = {
      async send() {
        return {
          Item: {
            intencao_id: 'int-999',
            usuario_id: 'outro-sub',
            valor_total: 100,
            status: 'PENDENTE',
            expires_at: 9_999_999_999,
          },
        };
      },
    };

    const runInexistente = createHandler(fakeClientInexistente);
    const res1 = await runInexistente({
      usuario_id: 'sub-user-1',
      intencao_id: 'int-falsa',
      metodo_pagamento: 'cartao',
    });
    assert.equal(res1.status, 'recusado');
    if (res1.status === 'recusado') assert.equal(res1.erro, 'INTENCAO_INVALIDA');

    const runOutro = createHandler(fakeClientOutroUsuario);
    const res2 = await runOutro({
      usuario_id: 'sub-user-1',
      intencao_id: 'int-999',
      metodo_pagamento: 'cartao',
    });
    assert.equal(res2.status, 'recusado');
    if (res2.status === 'recusado') assert.equal(res2.erro, 'INTENCAO_INVALIDA');
  });

  it('rejeita com INTENCAO_EXPIRADA quando expires_at já foi ultrapassado', async () => {
    setEnvTables();
    const fixedNowMs = 1_700_000_000_000;
    const nowSec = Math.floor(fixedNowMs / 1000);

    const fakeClient: DynamoPaymentClient = {
      async send() {
        return {
          Item: {
            intencao_id: 'int-expirada',
            usuario_id: 'sub-user-1',
            valor_total: 100,
            status: 'PENDENTE',
            expires_at: nowSec - 1,
          },
        };
      },
    };

    const run = createHandler(fakeClient, () => fixedNowMs);
    const res = await run({
      usuario_id: 'sub-user-1',
      intencao_id: 'int-expirada',
      metodo_pagamento: 'pix',
    });

    assert.equal(res.status, 'recusado');
    if (res.status === 'recusado') assert.equal(res.erro, 'INTENCAO_EXPIRADA');
  });

  it('garante idempotência com INTENCAO_JA_PAGA tanto em leitura quanto em colisão concorrente', async () => {
    setEnvTables();
    const fixedNowMs = 1_700_000_000_000;
    const nowSec = Math.floor(fixedNowMs / 1000);

    const fakeClientJaPaga: DynamoPaymentClient = {
      async send() {
        return {
          Item: {
            intencao_id: 'int-paga',
            usuario_id: 'sub-user-1',
            valor_total: 100,
            status: 'PAGO',
            expires_at: nowSec + 300,
          },
        };
      },
    };

    const res1 = await createHandler(fakeClientJaPaga, () => fixedNowMs)({
      usuario_id: 'sub-user-1',
      intencao_id: 'int-paga',
      metodo_pagamento: 'pix',
    });
    assert.equal(res1.status, 'recusado');
    if (res1.status === 'recusado') assert.equal(res1.erro, 'INTENCAO_JA_PAGA');

    // Simula duas requisições simultâneas: a 2ª passa do GetCommand mas falha atomicamente no item 0
    const fakeClientConcorrente: DynamoPaymentClient = {
      async send(command: GetCommand | TransactWriteCommand) {
        if (command instanceof GetCommand) {
          return {
            Item: {
              intencao_id: 'int-race',
              usuario_id: 'sub-user-1',
              valor_total: 100,
              status: 'PENDENTE',
              expires_at: nowSec + 300,
            },
          };
        }
        throw Object.assign(new Error('Transaction cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
        });
      },
    };

    const res2 = await createHandler(fakeClientConcorrente, () => fixedNowMs)({
      usuario_id: 'sub-user-1',
      intencao_id: 'int-race',
      metodo_pagamento: 'cartao',
    });
    assert.equal(res2.status, 'recusado');
    if (res2.status === 'recusado') assert.equal(res2.erro, 'INTENCAO_JA_PAGA');
  });

  it('rejeita com LIMITE_EXCEDIDO quando saldo_disponivel >= valor falha na transação atômica', async () => {
    setEnvTables();
    const fixedNowMs = 1_700_000_000_000;
    const nowSec = Math.floor(fixedNowMs / 1000);

    const fakeClientSemSaldo: DynamoPaymentClient = {
      async send(command: GetCommand | TransactWriteCommand) {
        if (command instanceof GetCommand) {
          return {
            Item: {
              intencao_id: 'int-cara',
              usuario_id: 'sub-user-pobre',
              valor_total: 3799.9,
              status: 'PENDENTE',
              expires_at: nowSec + 300,
            },
          };
        }
        throw Object.assign(new Error('Transaction cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
        });
      },
    };

    const res = await createHandler(fakeClientSemSaldo, () => fixedNowMs)({
      usuario_id: 'sub-user-pobre',
      intencao_id: 'int-cara',
      metodo_pagamento: 'cartao',
    });
    assert.equal(res.status, 'recusado');
    if (res.status === 'recusado') assert.equal(res.erro, 'LIMITE_EXCEDIDO');
  });

  it('falha explicitamente quando usuario_id não é fornecido', async () => {
    setEnvTables();
    const fakeClient: DynamoPaymentClient = {
      async send() {
        throw new Error('Não deveria acessar DynamoDB sem usuario_id');
      },
    };

    await assert.rejects(
      () => createHandler(fakeClient)({ intencao_id: 'int-123', metodo_pagamento: 'pix' }),
      /usuario_id/,
    );
  });
});
