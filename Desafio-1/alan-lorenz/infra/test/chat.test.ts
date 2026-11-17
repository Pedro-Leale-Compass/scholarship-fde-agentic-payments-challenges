import { PassThrough, Readable } from 'node:stream';
import {
  createRuntimeSessionId,
  forwardAgentEvent,
  parseRequest,
  readAgentEvents,
} from '../../api/chat';
import {
  conversationMessageKey,
  createCompletionRecords,
  createUserMessageRecord,
  putConversationRecord,
} from '../../api/conversation-store';

const conversaId = 'c3ad9981-cd4c-4a01-9a7a-f7248173ad19';

describe('chat request validation', () => {
  test('rejects events without an authenticated Cognito subject', () => {
    expect(parseRequest({})).toEqual({
      statusCode: 401,
      error: 'UNAUTHENTICATED_USER',
    });
  });

  test('uses the Cognito subject and ignores client-supplied identity', () => {
    const parsed = parseRequest({
      requestContext: {
        authorizer: {
          claims: { sub: 'trusted-cognito-sub' },
        },
      },
      body: JSON.stringify({
        userId: 'untrusted-client-value',
        conversaId,
        messages: [{ role: 'user', content: 'Olá' }],
      }),
    });

    expect('request' in parsed).toBe(true);
    if ('request' in parsed) {
      expect(parsed.request.userId).toBe('trusted-cognito-sub');
      expect(parsed.request.conversaId).toBe(conversaId);
    }
  });

  test('requires a valid conversation id and non-empty user history', () => {
    const event = {
      requestContext: {
        authorizer: { claims: { sub: 'trusted-cognito-sub' } },
      },
      body: JSON.stringify({
        conversaId: 'not-a-uuid',
        messages: [{ role: 'user', content: 'Olá' }],
      }),
    };

    expect(parseRequest(event)).toEqual({
      statusCode: 400,
      error: 'INVALID_CONVERSATION_ID',
    });
  });

  test('isolates runtime sessions by authenticated user and conversation', () => {
    const first = createRuntimeSessionId('user-one', conversaId);
    expect(first).toHaveLength(64);
    expect(createRuntimeSessionId('user-one', conversaId)).toBe(first);
    expect(createRuntimeSessionId('user-two', conversaId)).not.toBe(first);
  });
});

describe('chat conversation persistence', () => {
  test('uses the Cognito user, conversation, and turn for stable message keys', () => {
    const userMessage = createUserMessageRecord(
      'authenticated-user',
      conversaId,
      2,
      'Quero comprar um fone',
      '2026-11-16T20:00:00.000Z',
    );
    const assistantRecords = createCompletionRecords(
      'authenticated-user',
      conversaId,
      2,
      'Qual método de pagamento?',
      [],
      '2026-11-16T20:00:01.000Z',
    );

    expect(userMessage.userId).toBe('authenticated-user');
    expect(userMessage.messageKey).toBe(
      conversationMessageKey(conversaId, 2, 0),
    );
    expect(assistantRecords[0]?.messageKey).toBe(
      conversationMessageKey(conversaId, 2, 1),
    );
    expect(assistantRecords[0]?.content).toBe('Qual método de pagamento?');
  });

  test('persists tool records and assistant text via one table-scoped PutItem', async () => {
    const toolRecord = createCompletionRecords(
      'authenticated-user',
      conversaId,
      1,
      'Encontrei produtos.',
      [
        {
          name: 'listar_catalogo',
          arguments: {},
          result: { produtos: [{ id: 'prod_1' }, { id: 'prod_2' }] },
        },
      ],
      '2026-11-16T20:00:01.000Z',
    );
    const commandInputs: unknown[] = [];

    await putConversationRecord(
      async (command) => {
        commandInputs.push(command.input);
      },
      'AlanLorenz-Conversas',
      toolRecord[0]!,
    );

    expect(commandInputs).toHaveLength(1);
    expect(commandInputs[0]).toMatchObject({
      TableName: 'AlanLorenz-Conversas',
      Item: {
        userId: 'authenticated-user',
        conversaId,
        tipo: 'tool_call',
        tool: 'listar_catalogo',
        resultado: JSON.stringify({ produtos: 2 }),
        desfecho: 'consultado',
      },
    });
    expect(toolRecord[1]?.role).toBe('assistant');
  });
});

describe('AgentCore SSE parsing', () => {
  test('decodes events across chunk boundaries, including split UTF-8 characters', async () => {
    const chunks = [
      Buffer.from('data: {"type":"token","text":"Ol'),
      Buffer.from('á"}\r\n\r\n'),
      Buffer.from('data: {"type":"done"}\n\n'),
    ];
    const events: unknown[] = [];

    for await (const event of readAgentEvents(Readable.from(chunks))) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'token', text: 'Olá' },
      { type: 'done' },
    ]);
  });

  test('converts agent events into the existing chat UI NDJSON shape', async () => {
    const stream = new PassThrough();
    const chunks: string[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
    const output = new Promise<string>((resolve) => {
      stream.on('end', () => resolve(chunks.join('')));
    });

    forwardAgentEvent(stream, { type: 'token', text: 'Olá' });
    forwardAgentEvent(stream, {
      type: 'tool',
      name: 'listar_catalogo',
      arguments: {},
      result: { produtos: [] },
    });
    stream.end();

    await expect(output).resolves.toBe(
      '{"message":{"role":"assistant","content":"Olá"}}\n' +
        '{"tool":{"name":"listar_catalogo","arguments":{},"result":{"produtos":[]}}}\n',
    );
  });
});
