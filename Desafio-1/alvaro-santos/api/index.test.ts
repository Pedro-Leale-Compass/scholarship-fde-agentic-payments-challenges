import * as assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  createChatHandler,
  createStreamingChatHandler,
  extractJwtSub,
  toRuntimeSessionId,
  type AgentCoreInvoker,
  type ApiGatewayProxyEvent,
  type ConversationsStore,
  type WritableResponseStream,
} from './index';

describe('Chat API Lambda (#17 [API-01])', () => {
  const originalEnv = {
    table: process.env.CONVERSAS_TABLE_NAME,
    runtime: process.env.AGENT_RUNTIME_ARN,
    origin: process.env.ALLOWED_ORIGIN,
  };

  afterEach(() => {
    if (originalEnv.table === undefined) delete process.env.CONVERSAS_TABLE_NAME;
    else process.env.CONVERSAS_TABLE_NAME = originalEnv.table;

    if (originalEnv.runtime === undefined) delete process.env.AGENT_RUNTIME_ARN;
    else process.env.AGENT_RUNTIME_ARN = originalEnv.runtime;

    if (originalEnv.origin === undefined) delete process.env.ALLOWED_ORIGIN;
    else process.env.ALLOWED_ORIGIN = originalEnv.origin;
  });

  function createFakeStore(initialItems: Record<string, Record<string, unknown>> = {}): {
    store: ConversationsStore;
    items: Record<string, Record<string, unknown>>;
  } {
    const items = { ...initialItems };
    const store: ConversationsStore = {
      async send(command: GetCommand | PutCommand) {
        if (command instanceof GetCommand) {
          const key = command.input.Key?.session_id as string;
          return { Item: items[key] };
        }
        const item = command.input.Item as Record<string, unknown>;
        items[item.session_id as string] = item;
        return {};
      },
    };
    return { store, items };
  }

  it('rejeita 401 quando claim sub do JWT está ausente, mesmo com usuario_id spoofado no body', async () => {
    process.env.CONVERSAS_TABLE_NAME = 'alvaro-conversas';
    process.env.AGENT_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:006739439488:runtime/abc';

    let agentCalled = false;
    const { store } = createFakeStore();
    const handler = createChatHandler({
      conversationsStore: store,
      agentInvoker: {
        async invokeAgent() {
          agentCalled = true;
          return { response: 'não deveria executar' };
        },
      },
    });

    const event: ApiGatewayProxyEvent = {
      body: JSON.stringify({
        usuario_id: 'admin-forjado',
        messages: [{ role: 'user', content: 'Oi' }],
      }),
      requestContext: { authorizer: { claims: {} } },
    };

    const res = await handler(event);
    assert.equal(res.statusCode, 401);
    assert.equal(agentCalled, false);
    assert.equal(extractJwtSub(event), undefined);
  });

  it('ignora usuario_id enviado no body, injeta claim sub, emite NDJSON compatível com UI e persiste TTL', async () => {
    process.env.CONVERSAS_TABLE_NAME = 'alvaro-conversas';
    process.env.AGENT_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:006739439488:runtime/abc';
    process.env.ALLOWED_ORIGIN = 'https://nexus.example.com';

    let capturedUsuarioId = '';
    let capturedRuntimeSessionId = '';
    const fixedNowMs = 1_700_000_000_000;

    const { store, items } = createFakeStore();
    const invoker: AgentCoreInvoker = {
      async invokeAgent({ prompt, usuarioId, runtimeSessionId }) {
        capturedUsuarioId = usuarioId;
        capturedRuntimeSessionId = runtimeSessionId;
        assert.equal(prompt, 'Quero comprar um PS5');
        return {
          response: 'Registrei sua intenção para o PlayStation 5.',
          stopReason: 'endTurn',
          tools: [
            {
              name: 'registrar_intencao',
              arguments: { produto_id: 'prod_001', quantidade: 1 },
              result: {
                intencao_id: 'int-1',
                produto_id: 'prod_001',
                quantidade: 1,
                valor_total: 3799.9,
                moeda: 'BRL',
                status: 'pendente',
                expira_em: '2026-11-16T12:00:00.000Z',
              },
            },
          ],
        };
      },
    };

    const handler = createChatHandler({
      conversationsStore: store,
      agentInvoker: invoker,
      nowFn: () => fixedNowMs,
    });

    const res = await handler({
      body: JSON.stringify({
        usuario_id: 'atacante-tentando-forjar',
        sessionId: 'sessao-abc',
        messages: [{ role: 'user', content: 'Quero comprar um PS5' }],
      }),
      requestContext: {
        authorizer: { claims: { sub: 'cognito-sub-real-999' } },
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'application/x-ndjson; charset=utf-8');
    assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://nexus.example.com');
    assert.equal(capturedUsuarioId, 'cognito-sub-real-999');
    assert.equal(capturedRuntimeSessionId.length >= 33, true);
    assert.equal(
      capturedRuntimeSessionId,
      toRuntimeSessionId('cognito-sub-real-999:sessao-abc'),
    );

    const lines = res.body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    assert.equal(lines.length, 3);
    assert.ok('tool' in lines[0]!);
    assert.deepEqual(lines[1], {
      message: { role: 'assistant', content: 'Registrei sua intenção para o PlayStation 5.' },
    });
    assert.deepEqual(lines[2], { done: true });

    const persisted = items['cognito-sub-real-999:sessao-abc'];
    assert.ok(persisted);
    assert.equal(persisted.usuario_id, 'cognito-sub-real-999');
    assert.equal(persisted.expires_at, Math.floor(fixedNowMs / 1000) + 86400);
    const savedMessages = persisted.messages as Array<{ role: string; content: string }>;
    assert.equal(savedMessages.length, 2);
    assert.match(savedMessages[1]!.content, /\[intencao_id: int-1\]/);
  });

  it('envia o histórico completo de turnos anteriores e preserva intencao_id no segundo turno', async () => {
    process.env.CONVERSAS_TABLE_NAME = 'alvaro-conversas';
    process.env.AGENT_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:006739439488:runtime/abc';

    const { store } = createFakeStore({
      'sub-multi:sessao-multi': {
        session_id: 'sub-multi:sessao-multi',
        usuario_id: 'sub-multi',
        messages: [
          { role: 'user', content: 'Quero um PS5', timestamp: '2026-11-16T12:00:00.000Z' },
          {
            role: 'assistant',
            content: 'Intenção criada! Confirma no Pix ou cartão?\n[intencao_id: uuid-intencao-42]',
            timestamp: '2026-11-16T12:00:01.000Z',
          },
        ],
      },
    });

    let capturedHistory: Array<{ role: string; content: string }> = [];
    let capturedPrompt = '';

    const handler = createChatHandler({
      conversationsStore: store,
      agentInvoker: {
        async invokeAgent({ prompt, history }) {
          capturedPrompt = prompt;
          capturedHistory = history;
          return { response: 'Pagamento aprovado no Pix!', tools: [] };
        },
      },
    });

    const res = await handler({
      body: JSON.stringify({
        sessionId: 'sessao-multi',
        messages: [
          { role: 'user', content: 'Quero um PS5' },
          { role: 'assistant', content: 'Intenção criada! Confirma no Pix ou cartão?' },
          { role: 'user', content: 'Confirmo no Pix' },
        ],
      }),
      requestContext: { authorizer: { claims: { sub: 'sub-multi' } } },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(capturedPrompt, 'Confirmo no Pix');
    assert.equal(capturedHistory.length, 2);
    assert.deepEqual(capturedHistory[0], { role: 'user', content: 'Quero um PS5' });
    assert.match(capturedHistory[1]!.content, /uuid-intencao-42/);
  });

  it('retorna 400 para JSON malformado ou sem mensagem do usuário', async () => {
    process.env.CONVERSAS_TABLE_NAME = 'alvaro-conversas';
    process.env.AGENT_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:006739439488:runtime/abc';

    const { store } = createFakeStore();
    const handler = createChatHandler({ conversationsStore: store });

    const invalidJson = await handler({
      body: '{"messages": invalid',
      requestContext: { authorizer: { claims: { sub: 'sub-1' } } },
    });
    assert.equal(invalidJson.statusCode, 400);

    const emptyMessages = await handler({
      body: JSON.stringify({ messages: [{ role: 'assistant', content: 'Olá' }] }),
      requestContext: { authorizer: { claims: { sub: 'sub-1' } } },
    });
    assert.equal(emptyMessages.statusCode, 400);
  });

  it('emite evento NDJSON { error } sanitizado se AgentCore falhar sem vazar ARN/conta/stack', async () => {
    process.env.CONVERSAS_TABLE_NAME = 'alvaro-conversas';
    process.env.AGENT_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:006739439488:runtime/abc';

    const { store } = createFakeStore();
    const handler = createChatHandler({
      conversationsStore: store,
      agentInvoker: {
        async invokeAgent() {
          throw new Error(
            'AccessDeniedException: arn:aws:bedrock-agentcore:us-east-1:006739439488:secret-internal',
          );
        },
      },
    });

    const res = await handler({
      body: JSON.stringify({ prompt: 'Qual meu saldo?' }),
      requestContext: { authorizer: { claims: { sub: 'sub-1' } } },
    });

    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(
      res.body,
      /AccessDeniedException|arn:aws|006739439488|secret-internal/i,
    );
    const eventLine = JSON.parse(res.body.trim()) as { error: string };
    assert.match(eventLine.error, /Não foi possível processar sua mensagem/);
  });

  it('usa HttpResponseStream.from com Response Streaming quando awslambda global está presente', async () => {
    process.env.CONVERSAS_TABLE_NAME = 'alvaro-conversas';
    process.env.AGENT_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:006739439488:runtime/abc';

    const { store } = createFakeStore();
    let capturedMeta: { statusCode: number; headers: Record<string, string> } | undefined;
    const chunks: string[] = [];

    const rawStream: WritableResponseStream = {
      write(chunk) {
        chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      },
      end() {},
    };

    const g = globalThis as Record<string, unknown>;
    const previousAwslambda = g.awslambda;
    g.awslambda = {
      HttpResponseStream: {
        from(stream: WritableResponseStream, meta: { statusCode: number; headers: Record<string, string> }) {
          capturedMeta = meta;
          return stream;
        },
      },
    };

    try {
      const streamingHandler = createStreamingChatHandler({
        conversationsStore: store,
        agentInvoker: {
          async invokeAgent() {
            return { response: 'Resposta via stream!', tools: [] };
          },
        },
      });

      await streamingHandler(
        {
          body: JSON.stringify({ prompt: 'Olá' }),
          requestContext: { authorizer: { claims: { sub: 'sub-stream-1' } } },
        },
        rawStream,
      );

      assert.equal(capturedMeta?.statusCode, 200);
      assert.equal(
        capturedMeta?.headers['Content-Type'],
        'application/x-ndjson; charset=utf-8',
      );
      const parsed = chunks
        .join('')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.deepEqual(parsed, [
        { message: { role: 'assistant', content: 'Resposta via stream!' } },
        { done: true },
      ]);
    } finally {
      if (previousAwslambda === undefined) delete g.awslambda;
      else g.awslambda = previousAwslambda;
    }
  });

  it('createChatHandler ignora HttpResponseStream.from mesmo quando globalThis.awslambda existe', async () => {
    process.env.CONVERSAS_TABLE_NAME = 'alvaro-conversas';
    process.env.AGENT_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:006739439488:runtime/abc';

    const { store } = createFakeStore();
    const g = globalThis as Record<string, unknown>;
    const previousAwslambda = g.awslambda;
    g.awslambda = {
      HttpResponseStream: {
        from() {
          throw new TypeError('underlyingStream.setContentType is not a function');
        },
      },
    };

    try {
      const handler = createChatHandler({
        conversationsStore: store,
        agentInvoker: {
          async invokeAgent() {
            return { response: 'Resposta em buffer sem erro de stream!', tools: [] };
          },
        },
      });

      const res = await handler({
        body: JSON.stringify({ prompt: 'Olá' }),
        requestContext: { authorizer: { claims: { sub: 'sub-buffer-1' } } },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['Content-Type'], 'application/x-ndjson; charset=utf-8');
      const lines = res.body
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.deepEqual(lines, [
        { message: { role: 'assistant', content: 'Resposta em buffer sem erro de stream!' } },
        { done: true },
      ]);
    } finally {
      if (previousAwslambda === undefined) delete g.awslambda;
      else g.awslambda = previousAwslambda;
    }
  });

  it('envolve o handler com globalThis.awslambda.streamifyResponse quando disponível no runtime AWS', () => {
    const g = globalThis as Record<string, unknown>;
    const previousAwslambda = g.awslambda;
    let streamifiedFn: unknown;
    const sentinelHandler = () => 'streamified-handler';

    g.awslambda = {
      streamifyResponse(fn: unknown) {
        streamifiedFn = fn;
        return sentinelHandler;
      },
    };

    const resolved = require.resolve('./index');
    const previousCache = require.cache[resolved];
    try {
      delete require.cache[resolved];
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./index') as { handler: unknown };
      assert.equal(typeof streamifiedFn, 'function');
      assert.equal(mod.handler, sentinelHandler);
    } finally {
      if (previousCache) require.cache[resolved] = previousCache;
      else delete require.cache[resolved];
      if (previousAwslambda === undefined) delete g.awslambda;
      else g.awslambda = previousAwslambda;
    }
  });
});
