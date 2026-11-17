import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { ToolContext } from '@strands-agents/sdk';
import {
  createPaymentTools,
  type LambdaInvoker,
  type ToolExecutionEvent,
} from './tools.js';

function createFakeContext(usuarioId?: string): ToolContext {
  return {
    invocationState: usuarioId !== undefined ? { usuarioId } : {},
  } as unknown as ToolContext;
}

describe('Strands Payment Tools (AGENT-02)', () => {
  const originalEnv = {
    consultar: process.env.TOOL_CONSULTAR_SALDO_FUNCTION_NAME,
    criar: process.env.TOOL_CRIAR_INTENCAO_FUNCTION_NAME,
    confirmar: process.env.TOOL_CONFIRMAR_PAGAMENTO_FUNCTION_NAME,
  };

  afterEach(() => {
    if (originalEnv.consultar === undefined) {
      delete process.env.TOOL_CONSULTAR_SALDO_FUNCTION_NAME;
    } else {
      process.env.TOOL_CONSULTAR_SALDO_FUNCTION_NAME = originalEnv.consultar;
    }
    if (originalEnv.criar === undefined) {
      delete process.env.TOOL_CRIAR_INTENCAO_FUNCTION_NAME;
    } else {
      process.env.TOOL_CRIAR_INTENCAO_FUNCTION_NAME = originalEnv.criar;
    }
    if (originalEnv.confirmar === undefined) {
      delete process.env.TOOL_CONFIRMAR_PAGAMENTO_FUNCTION_NAME;
    } else {
      process.env.TOOL_CONFIRMAR_PAGAMENTO_FUNCTION_NAME = originalEnv.confirmar;
    }
  });

  it('gera toolSpec válido para as 3 ferramentas registradas', () => {
    const noopInvoker: LambdaInvoker = {
      invoke: async () => ({}) as never,
    };
    const [listar, registrar, realizar] = createPaymentTools({ invoker: noopInvoker });

    assert.equal(listar.name, 'listar_catalogo');
    assert.equal(registrar.name, 'registrar_intencao');
    assert.equal(realizar.name, 'realizar_compra');
    assert.ok(listar.toolSpec.inputSchema);
    assert.ok(registrar.toolSpec.inputSchema);
    assert.ok(realizar.toolSpec.inputSchema);
  });

  it('listar_catalogo injeta usuario_id do invocationState e repassa categoria opcional', async () => {
    process.env.TOOL_CONSULTAR_SALDO_FUNCTION_NAME = 'fn-consultar-saldo';
    const calls: Array<{ fn: string; payload: Record<string, unknown> }> = [];
    const events: ToolExecutionEvent[] = [];

    const mockInvoker: LambdaInvoker = {
      async invoke<TResult>(fn: string, payload: Record<string, unknown>) {
        calls.push({ fn, payload });
        return {
          usuario_encontrado: true,
          usuario_id: payload.usuario_id,
          saldo_disponivel: 2000,
          moeda: 'BRL',
          produtos: [{ id: 'prod_002', nome: 'Headset', preco: 349.9, moeda: 'BRL', estoque: 5 }],
        } as TResult;
      },
    };

    const [listarCatalogo] = createPaymentTools({
      invoker: mockInvoker,
      onToolEvent: (ev) => events.push(ev),
    });

    const output = await listarCatalogo.invoke(
      { categoria: 'headsets' },
      createFakeContext('cognito-sub-123'),
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      fn: 'fn-consultar-saldo',
      payload: { usuario_id: 'cognito-sub-123', categoria: 'headsets' },
    });
    assert.equal((output as { saldo_disponivel: number }).saldo_disponivel, 2000);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.name, 'listar_catalogo');
    assert.deepEqual(events[0]?.arguments, { categoria: 'headsets' });
  });

  it('registrar_intencao normaliza status PENDENTE para pendente e emite evento', async () => {
    process.env.TOOL_CRIAR_INTENCAO_FUNCTION_NAME = 'fn-criar-intencao';
    const calls: Array<{ fn: string; payload: Record<string, unknown> }> = [];
    const events: ToolExecutionEvent[] = [];

    const mockInvoker: LambdaInvoker = {
      async invoke<TResult>(fn: string, payload: Record<string, unknown>) {
        calls.push({ fn, payload });
        return {
          intencao_id: 'int-abc-1',
          produto_id: 'prod_001',
          produto_nome: 'PlayStation 5 Slim 1TB',
          quantidade: 1,
          valor_total: 3799.9,
          moeda: 'BRL',
          status: 'PENDENTE',
          expira_em: '2026-11-15T20:00:00.000Z',
        } as TResult;
      },
    };

    const [, registrarIntencao] = createPaymentTools({
      invoker: mockInvoker,
      onToolEvent: (ev) => events.push(ev),
    });

    const output = (await registrarIntencao.invoke(
      { produto_id: 'prod_001', quantidade: 1 },
      createFakeContext('cognito-sub-456'),
    )) as { intencao_id: string; status: string };

    assert.deepEqual(calls[0], {
      fn: 'fn-criar-intencao',
      payload: { usuario_id: 'cognito-sub-456', produto_id: 'prod_001', quantidade: 1 },
    });
    assert.equal(output.status, 'pendente');
    assert.equal(events[0]?.name, 'registrar_intencao');
    assert.equal((events[0]?.result as { status: string }).status, 'pendente');
  });

  it('realizar_compra repassa metodo_pagamento e usuario_id seguro', async () => {
    process.env.TOOL_CONFIRMAR_PAGAMENTO_FUNCTION_NAME = 'fn-confirmar-pagamento';
    const calls: Array<{ fn: string; payload: Record<string, unknown> }> = [];

    const mockInvoker: LambdaInvoker = {
      async invoke<TResult>(fn: string, payload: Record<string, unknown>) {
        calls.push({ fn, payload });
        return {
          status: 'aprovado',
          transacao_id: 'tx-999',
          intencao_id: payload.intencao_id,
          valor: 79.9,
          metodo_pagamento: payload.metodo_pagamento,
          limite_restante: 1920.1,
          data: '2026-11-15T19:50:00.000Z',
        } as TResult;
      },
    };

    const [, , realizarCompra] = createPaymentTools({ invoker: mockInvoker });

    const output = (await realizarCompra.invoke(
      { intencao_id: 'int-777', metodo_pagamento: 'pix' },
      createFakeContext('cognito-sub-789'),
    )) as { status: string; transacao_id: string };

    assert.deepEqual(calls[0], {
      fn: 'fn-confirmar-pagamento',
      payload: { usuario_id: 'cognito-sub-789', intencao_id: 'int-777', metodo_pagamento: 'pix' },
    });
    assert.equal(output.status, 'aprovado');
    assert.equal(output.transacao_id, 'tx-999');
  });

  it('bloqueia chamada Lambda quando invocationState.usuarioId está ausente', async () => {
    let called = false;
    const mockInvoker: LambdaInvoker = {
      async invoke() {
        called = true;
        return {} as never;
      },
    };

    const [listarCatalogo] = createPaymentTools({ invoker: mockInvoker });
    const output = (await listarCatalogo.invoke({}, createFakeContext())) as {
      status: string;
      codigo: string;
      mensagem: string;
    };

    assert.equal(called, false);
    assert.equal(output.status, 'recusado');
    assert.equal(output.codigo, 'USUARIO_NAO_AUTENTICADO');
  });

  it('preserva erro de domínio seguro e sanitiza exceções internas com ARN/stack', async () => {
    const domainFailingInvoker: LambdaInvoker = {
      async invoke() {
        throw new Error('Estoque insuficiente para PlayStation 5: solicitado 10, disponível 2.');
      },
    };

    const [, registrarIntencao] = createPaymentTools({ invoker: domainFailingInvoker });
    const domainErrorOutput = (await registrarIntencao.invoke(
      { produto_id: 'prod_001', quantidade: 10 },
      createFakeContext('sub-1'),
    )) as { status: string; codigo: string; mensagem: string };

    assert.equal(domainErrorOutput.status, 'recusado');
    assert.equal(domainErrorOutput.codigo, 'VALIDACAO_NEGOCIO');
    assert.match(domainErrorOutput.mensagem, /Estoque insuficiente/);

    const secretFailingInvoker: LambdaInvoker = {
      async invoke() {
        throw new Error(
          'AccessDeniedException: User arn:aws:sts::006739439488:assumed-role/alvaro-role is not authorized',
        );
      },
    };

    const [, , realizarCompra] = createPaymentTools({ invoker: secretFailingInvoker });
    const infraErrorOutput = (await realizarCompra.invoke(
      { intencao_id: 'int-1', metodo_pagamento: 'cartao' },
      createFakeContext('sub-1'),
    )) as { status: string; codigo: string; mensagem: string };

    assert.equal(infraErrorOutput.status, 'recusado');
    assert.equal(infraErrorOutput.codigo, 'ERRO_PROCESSAMENTO');
    assert.doesNotMatch(
      JSON.stringify(infraErrorOutput),
      /AccessDeniedException|arn:aws|006739439488/i,
    );
  });
});
