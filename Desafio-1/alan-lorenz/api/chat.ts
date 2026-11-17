import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import type { StreamifyHandler } from 'aws-lambda';
import { createHash } from 'node:crypto';
import type { Writable } from 'node:stream';
import {
  createCompletionRecords,
  createUserMessageRecord,
  saveConversationRecord,
  type ToolEventRecord,
} from './conversation-store.ts';
import { ensureChatUser } from './user-store.ts';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const agentCore = new BedrockAgentCoreClient({});

type ChatMessage = {
  role?: unknown;
  content?: unknown;
};

type ChatApiEvent = {
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
  requestContext?: {
    authorizer?: {
      claims?: Record<string, unknown>;
    };
  };
};

type ChatRequest = {
  userId: string;
  conversaId: string;
  messages: ChatMessage[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestHeaders(event: ChatApiEvent): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  return headers;
}

function responseHeaders(event: ChatApiEvent): Record<string, string> {
  const headers: Record<string, string> = {
    'Cache-Control': 'no-store',
  };
  const origin = requestHeaders(event).origin;
  if (
    typeof process.env.FRONTEND_ORIGIN === 'string' &&
    origin === process.env.FRONTEND_ORIGIN
  ) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  return headers;
}

export function parseRequest(event: ChatApiEvent):
  | { request: ChatRequest }
  | { statusCode: number; error: string } {
  const userId = event.requestContext?.authorizer?.claims?.sub;
  if (typeof userId !== 'string' || !userId.trim()) {
    return { statusCode: 401, error: 'UNAUTHENTICATED_USER' };
  }
  if (typeof event.body !== 'string' || !event.body) {
    return { statusCode: 400, error: 'REQUEST_BODY_REQUIRED' };
  }

  let body: unknown;
  try {
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    body = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, error: 'INVALID_JSON_BODY' };
  }

  if (!isRecord(body)) {
    return { statusCode: 400, error: 'INVALID_REQUEST_BODY' };
  }
  const { conversaId, messages } = body;
  if (typeof conversaId !== 'string' || !UUID_V4.test(conversaId.trim())) {
    return { statusCode: 400, error: 'INVALID_CONVERSATION_ID' };
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return { statusCode: 400, error: 'MESSAGES_REQUIRED' };
  }
  const chatMessages = messages.filter(isRecord);
  if (chatMessages.length !== messages.length) {
    return { statusCode: 400, error: 'INVALID_MESSAGE' };
  }
  if (
    !chatMessages.some(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.trim().length > 0,
    )
  ) {
    return { statusCode: 400, error: 'USER_MESSAGE_REQUIRED' };
  }

  return {
    request: {
      userId: userId.trim(),
      conversaId: conversaId.trim().toLowerCase(),
      messages: chatMessages,
    },
  };
}

export function createRuntimeSessionId(userId: string, conversaId: string) {
  return createHash('sha256')
    .update(`${userId}\0${conversaId}`)
    .digest('hex');
}

function currentTurn(messages: ChatMessage[]) {
  let latestUserMessage: string | undefined;
  let turnNumber = 0;
  for (const message of messages) {
    if (
      message.role === 'user' &&
      typeof message.content === 'string' &&
      message.content.trim()
    ) {
      latestUserMessage = message.content;
      turnNumber += 1;
    }
  }
  if (latestUserMessage === undefined) {
    throw new Error('A non-empty user message is required');
  }
  return { latestUserMessage, turnNumber };
}

function httpResponseStream(
  responseStream: Writable,
  event: ChatApiEvent,
  statusCode: number,
  contentType: string,
) {
  return awslambda.HttpResponseStream.from(responseStream, {
    statusCode,
    headers: {
      'Content-Type': contentType,
      ...responseHeaders(event),
    },
  });
}

function writeJsonError(
  responseStream: Writable,
  event: ChatApiEvent,
  statusCode: number,
  error: string,
) {
  const stream = httpResponseStream(
    responseStream,
    event,
    statusCode,
    'application/json; charset=utf-8',
  );
  stream.write(JSON.stringify({ error }));
  stream.end();
}

function parseSseFrame(frame: string): unknown | undefined {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data || data === '[DONE]') {
    return undefined;
  }
  return JSON.parse(data);
}

function isAsyncByteStream(
  value: unknown,
): value is AsyncIterable<Uint8Array> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof Reflect.get(value, Symbol.asyncIterator) === 'function'
  );
}

export async function* readAgentEvents(
  response: AsyncIterable<Uint8Array>,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0];
      buffer = buffer.slice(boundary + (separator?.length ?? 2));
      const event = parseSseFrame(frame);
      if (event !== undefined) {
        yield event;
      }
      boundary = buffer.search(/\r?\n\r?\n/);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const event = parseSseFrame(buffer);
    if (event !== undefined) {
      yield event;
    }
  }
}

export function forwardAgentEvent(stream: Writable, value: unknown) {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  if (value.type === 'token' && typeof value.text === 'string') {
    stream.write(
      `${JSON.stringify({
        message: { role: 'assistant', content: value.text },
      })}\n`,
    );
    return false;
  }
  if (value.type === 'tool') {
    stream.write(
      `${JSON.stringify({
        tool: {
          name: value.name,
          arguments: value.arguments,
          result: value.result,
        },
      })}\n`,
    );
    return false;
  }
  if (value.type === 'error') {
    stream.write(
      `${JSON.stringify({
        error:
          typeof value.message === 'string'
            ? value.message
            : 'AGENT_INVOCATION_FAILED',
      })}\n`,
    );
    return false;
  }
  if (value.type === 'done') {
    stream.write(`${JSON.stringify({ done: true })}\n`);
    return true;
  }
  return false;
}

export const handler: StreamifyHandler<ChatApiEvent> = awslambda.streamifyResponse(
  async (event: ChatApiEvent, responseStream: Writable) => {
    const parsed = parseRequest(event);
    if (!('request' in parsed)) {
      writeJsonError(responseStream, event, parsed.statusCode, parsed.error);
      return;
    }
    const agentRuntimeArn = process.env.AGENT_RUNTIME_ARN;
    if (!agentRuntimeArn) {
      writeJsonError(responseStream, event, 500, 'AGENT_RUNTIME_NOT_CONFIGURED');
      return;
    }

    const { userId, conversaId, messages } = parsed.request;
    const { latestUserMessage, turnNumber } = currentTurn(messages);
    try {
      await ensureChatUser(userId);
      await saveConversationRecord(
        createUserMessageRecord(
          userId,
          conversaId,
          turnNumber,
          latestUserMessage,
        ),
      );
    } catch (error) {
      console.error('Failed to prepare the chat request:', error);
      writeJsonError(
        responseStream,
        event,
        500,
        'CONVERSATION_PERSISTENCE_FAILED',
      );
      return;
    }

    const stream = httpResponseStream(
      responseStream,
      event,
      200,
      'application/x-ndjson; charset=utf-8',
    );
    let done = false;
    let assistantContent = '';
    const toolEvents: ToolEventRecord[] = [];
    try {
      const result = await agentCore.send(
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn,
          runtimeSessionId: createRuntimeSessionId(userId, conversaId),
          contentType: 'application/json',
          accept: 'text/event-stream',
          payload: Buffer.from(
            JSON.stringify({ userId, conversaId, messages }),
          ),
        }),
      );
      if (!isAsyncByteStream(result.response)) {
        throw new Error('AgentCore returned no streaming response');
      }

      for await (const agentEvent of readAgentEvents(result.response)) {
        if (isRecord(agentEvent) && agentEvent.type === 'done') {
          continue;
        }
        if (
          isRecord(agentEvent) &&
          agentEvent.type === 'token' &&
          typeof agentEvent.text === 'string'
        ) {
          assistantContent += agentEvent.text;
        } else if (
          isRecord(agentEvent) &&
          agentEvent.type === 'tool' &&
          typeof agentEvent.name === 'string'
        ) {
          toolEvents.push({
            name: agentEvent.name,
            arguments: agentEvent.arguments,
            result: agentEvent.result,
          });
        }
        done = forwardAgentEvent(stream, agentEvent) || done;
      }
    } catch (error) {
      console.error('AgentCore chat invocation failed:', error);
      stream.write(
        `${JSON.stringify({
          error: 'AGENT_INVOCATION_FAILED',
          done: true,
        })}\n`,
      );
      done = true;
    } finally {
      try {
        const completionRecords = createCompletionRecords(
          userId,
          conversaId,
          turnNumber,
          assistantContent,
          toolEvents,
        );
        for (const record of completionRecords) {
          await saveConversationRecord(record);
        }
      } catch (error) {
        console.error('Failed to persist the chat response:', error);
        stream.write(
          `${JSON.stringify({
            error: 'CONVERSATION_PERSISTENCE_FAILED',
            done: true,
          })}\n`,
        );
        done = true;
      }
      if (!done) {
        stream.write(`${JSON.stringify({ done: true })}\n`);
      }
      stream.end();
    }
  },
);
