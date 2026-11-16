import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import {
  DEFAULT_AWS_REGION,
  DEFAULT_BEDROCK_MODEL_ID,
  NEXUS_STORE_SYSTEM_PROMPT,
} from './prompt.js';
import {
  buildSeedMessages,
  createServer,
  type AgentRunner,
  type InvocationPayload,
} from './server.js';

async function withServer(
  runner: AgentRunner,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = createServer(runner);
  const server = http.createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  try {
    const address = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe('Nexus Store Agent Config & Prompt', () => {
  it('configura Claude 3 Haiku na região us-east-1 como padrão', () => {
    assert.equal(DEFAULT_BEDROCK_MODEL_ID, 'us.anthropic.claude-3-haiku-20240307-v1:0');
    assert.equal(DEFAULT_AWS_REGION, 'us-east-1');
  });

  it('impõe fluxo sequencial obrigatório, origem segura de usuario_id e proteção contra stack traces', () => {
    assert.match(NEXUS_STORE_SYSTEM_PROMPT, /listar_catalogo/);
    assert.match(NEXUS_STORE_SYSTEM_PROMPT, /registrar_intencao/);
    assert.match(NEXUS_STORE_SYSTEM_PROMPT, /realizar_compra/);
    assert.match(NEXUS_STORE_SYSTEM_PROMPT, /pix/i);
    assert.match(NEXUS_STORE_SYSTEM_PROMPT, /cartao/i);
    assert.match(NEXUS_STORE_SYSTEM_PROMPT, /usuario_id/);
    assert.match(NEXUS_STORE_SYSTEM_PROMPT, /sub/);
    assert.match(NEXUS_STORE_SYSTEM_PROMPT, /stack trace/i);
  });
});

describe('AgentCore HTTP Runtime Server', () => {
  const noopRunner: AgentRunner = async () => ({
    response: 'Olá! Como posso ajudar na Nexus Store?',
    stopReason: 'endTurn',
  });

  it('GET /ping responde 200 com status Healthy', async () => {
    await withServer(noopRunner, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ping`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { status: string; time_of_last_update: number };
      assert.equal(body.status, 'Healthy');
      assert.equal(typeof body.time_of_last_update, 'number');
    });
  });

  it('POST /invocations aceita payload JSON bruto e retorna resposta do runner', async () => {
    let receivedPayload: InvocationPayload | null = null;

    const spyRunner: AgentRunner = async (payload) => {
      receivedPayload = payload;
      return {
        response: 'Temos fone Bluetooth em estoque.',
        stopReason: 'endTurn',
        tools: [{ name: 'listar_catalogo', arguments: {}, result: { produtos: [] } }],
      };
    };

    await withServer(spyRunner, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/invocations`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: JSON.stringify({
          prompt: 'Quais produtos estão disponíveis?',
          usuarioId: 'sub-usuario-123',
        }),
      });

      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        response: string;
        stopReason?: string;
        tools?: unknown[];
      };
      assert.equal(body.response, 'Temos fone Bluetooth em estoque.');
      assert.equal(body.stopReason, 'endTurn');
      assert.equal(body.tools?.length, 1);
      assert.deepEqual(receivedPayload, {
        prompt: 'Quais produtos estão disponíveis?',
        usuarioId: 'sub-usuario-123',
      });
    });
  });

  it('POST /invocations retorna 400 para JSON malformado sem vazar erro interno', async () => {
    await withServer(noopRunner, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/invocations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"prompt": invalid',
      });

      assert.equal(res.status, 400);
      const text = await res.text();
      assert.doesNotMatch(text, /SyntaxError|Unexpected token/i);
      const body = JSON.parse(text) as { error: string };
      assert.ok(body.error.length > 0);
    });
  });

  it('POST /invocations retorna 400 quando prompt está ausente ou vazio sem chamar runner', async () => {
    let called = false;
    const guardRunner: AgentRunner = async () => {
      called = true;
      return { response: 'não deveria executar' };
    };

    await withServer(guardRunner, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/invocations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: '   ' }),
      });

      assert.equal(res.status, 400);
      assert.equal(called, false);
    });
  });

  it('POST /invocations retorna 500 amigável quando runner falha, sem vazar stack trace ou segredo', async () => {
    const failingRunner: AgentRunner = async () => {
      throw new Error('AccessDeniedException: arn:aws:bedrock:us-east-1:006739439488:internal-secret');
    };

    await withServer(failingRunner, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/invocations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Olá' }),
      });

      assert.equal(res.status, 500);
      const rawText = await res.text();
      assert.doesNotMatch(rawText, /AccessDeniedException|006739439488|internal-secret|Error:/i);
      const body = JSON.parse(rawText) as { error: string };
      assert.match(body.error, /Não foi possível processar sua solicitação/);
    });
  });

  it('POST /invocations aceita history e buildSeedMessages garante alternância válida para Bedrock', async () => {
    const normalized = buildSeedMessages([
      { role: 'assistant', content: 'Saudação inicial ignorada antes do user' },
      { role: 'user', content: 'Quero um PS5' },
      { role: 'user', content: 'Pode ser 1 unidade' },
      { role: 'assistant', content: 'Intenção int-1 registrada. Confirma?' },
    ]);

    assert.deepEqual(normalized, [
      { role: 'user', content: [{ text: 'Quero um PS5\n\nPode ser 1 unidade' }] },
      { role: 'assistant', content: [{ text: 'Intenção int-1 registrada. Confirma?' }] },
    ]);

    let receivedHistory: InvocationPayload['history'];
    const spyRunner: AgentRunner = async (payload) => {
      receivedHistory = payload.history;
      return { response: 'Compra confirmada!', stopReason: 'endTurn', tools: [] };
    };

    await withServer(spyRunner, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/invocations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Confirmo no Pix',
          usuarioId: 'sub-usuario-123',
          history: [
            { role: 'user', content: 'Quero um PS5' },
            { role: 'assistant', content: 'Intenção int-1 registrada. Confirma?' },
          ],
        }),
      });

      assert.equal(res.status, 200);
      assert.equal(receivedHistory?.length, 2);
      assert.equal(receivedHistory?.[1]?.content, 'Intenção int-1 registrada. Confirma?');
    });
  });
});
