import { createHash } from 'node:crypto';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const CONVERSA_TTL_SEGUNDOS = 24 * 60 * 60;
const MAX_MENSAGENS = 50;

export interface ApiGatewayProxyEvent {
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
  readonly requestContext?: {
    readonly authorizer?: {
      readonly claims?: { readonly sub?: unknown };
      readonly jwt?: { readonly claims?: { readonly sub?: unknown } };
    };
  };
}

export interface HistoryMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface AgentCoreInvocationResult {
  readonly response: string;
  readonly stopReason?: string;
  readonly tools?: Array<{ name: string; arguments: Record<string, unknown>; result?: unknown }>;
}

export interface AgentCoreInvoker {
  invokeAgent(params: {
    prompt: string;
    usuarioId: string;
    sessionId: string;
    runtimeSessionId: string;
    history: HistoryMessage[];
  }): Promise<AgentCoreInvocationResult>;
}

export interface ConversationsStore {
  send(command: GetCommand): Promise<{ Item?: Record<string, unknown> }>;
  send(command: PutCommand): Promise<unknown>;
}

export interface WritableResponseStream {
  write(chunk: string | Uint8Array): boolean | void;
  end(): void;
}

export interface ChatHandlerDependencies {
  readonly conversationsStore?: ConversationsStore;
  readonly agentInvoker?: AgentCoreInvoker;
  readonly nowFn?: () => number;
}

interface HttpMetadata {
  statusCode: number;
  headers: Record<string, string>;
}

let docClient: ConversationsStore | undefined;
let agentClient: BedrockAgentCoreClient | undefined;

function getAwsLambdaGlobal() {
  return (globalThis as {
    awslambda?: {
      streamifyResponse?: (
        fn: (event: ApiGatewayProxyEvent, stream: WritableResponseStream) => Promise<void>,
      ) => unknown;
      HttpResponseStream?: { from(stream: WritableResponseStream, meta: HttpMetadata): WritableResponseStream };
    };
  }).awslambda;
}

/**
 * 1. Identidade segura: extrai o usuario_id apenas da claim `sub` do JWT validado no Cognito.
 */
export function extractJwtSub(event: ApiGatewayProxyEvent | undefined): string | undefined {
  const sub = event?.requestContext?.authorizer?.claims?.sub ?? event?.requestContext?.authorizer?.jwt?.claims?.sub;
  return typeof sub === 'string' && sub.trim() ? sub.trim() : undefined;
}

/**
 * Gera ID de sessao com 64 caracteres hexadecimais (AWS AgentCore exige >= 33 caracteres).
 */
export function toRuntimeSessionId(sessionKey: string): string {
  return createHash('sha256').update(sessionKey).digest('hex');
}

function parseChatPayload(
  event: ApiGatewayProxyEvent,
):
  | { ok: true; prompt: string; rawSessionId: string; clientHistory: HistoryMessage[] }
  | { ok: false; error: string } {
  const rawBody = event.body
    ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body).trim()
    : '';
  if (!rawBody) return { ok: false, error: 'Corpo da requisição ausente. Envie sua mensagem em JSON.' };

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'O payload da requisição deve ser um objeto JSON.' };
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'Payload JSON inválido.' };
  }

  let prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  let clientHistory: HistoryMessage[] = [];

  if (Array.isArray(body.messages)) {
    let lastUserIdx = -1;
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const m = body.messages[i] as Record<string, unknown> | null;
      if (m && typeof m === 'object' && m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
        lastUserIdx = i;
        break;
      }
    }

    if (!prompt && lastUserIdx !== -1) {
      prompt = String((body.messages[lastUserIdx] as Record<string, unknown>).content).trim();
    }

    const historySlice = lastUserIdx !== -1 ? body.messages.slice(0, lastUserIdx) : body.messages;
    clientHistory = historySlice.flatMap((m): HistoryMessage[] => {
      if (!m || typeof m !== 'object') return [];
      const rec = m as Record<string, unknown>;
      if ((rec.role === 'user' || rec.role === 'assistant') && typeof rec.content === 'string' && rec.content.trim()) {
        return [{ role: rec.role, content: rec.content.trim() }];
      }
      return [];
    });
  }

  if (!prompt) return { ok: false, error: 'Nenhuma mensagem de usuário válida foi encontrada na requisição.' };

  const rawSessionId =
    typeof body.sessionId === 'string' && body.sessionId.trim()
      ? body.sessionId.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default'
      : 'default';

  return { ok: true, prompt, rawSessionId, clientHistory };
}

async function readAgentPayloadText(payload: unknown): Promise<string> {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload).toString('utf8');
  if (typeof (payload as { transformToString?: unknown }).transformToString === 'function') {
    return (payload as { transformToString: (enc: string) => Promise<string> }).transformToString('utf8');
  }
  if (Symbol.asyncIterator in (payload as object)) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of payload as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  return '';
}

function createAwsAgentCoreInvoker(): AgentCoreInvoker {
  return {
    async invokeAgent({ prompt, usuarioId, sessionId, runtimeSessionId, history }) {
      const agentRuntimeArn = process.env.AGENT_RUNTIME_ARN?.trim();
      if (!agentRuntimeArn) throw new Error('AGENT_RUNTIME_ARN não configurado.');

      agentClient ??= new BedrockAgentCoreClient({});
      const result = await agentClient.send(
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn,
          runtimeSessionId,
          contentType: 'application/json',
          accept: 'application/json',
          payload: new TextEncoder().encode(JSON.stringify({ prompt, usuarioId, sessionId, history })),
        }),
      );

      const rawText = (await readAgentPayloadText(result.response)).trim();
      const parsed = rawText ? (JSON.parse(rawText) as Partial<AgentCoreInvocationResult>) : {};
      if (typeof parsed.response !== 'string') {
        throw new Error('Formato de resposta inválido recebido do AgentCore Runtime.');
      }
      return { response: parsed.response, stopReason: parsed.stopReason, tools: parsed.tools ?? [] };
    },
  };
}

/**
 * Garante que identificadores [intencao_id: ...] salvos no DynamoDB não se percam entre turnos
 * caso o texto exibido pelo frontend tenha omitido o UUID bruto da intenção.
 */
function enrichHistoryWithIntentIds(
  clientHistory: HistoryMessage[],
  priorMessages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
): HistoryMessage[] {
  const base = clientHistory.length > 0 ? clientHistory.map((m) => ({ ...m })) : priorMessages.map(({ role, content }) => ({ role, content }));
  const priorTags = priorMessages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => Array.from(m.content.matchAll(/\[intencao_id:\s*([^\]]+)\]/g), (match) => match[1].trim()));

  const fullText = base.map((m) => m.content).join('\n');
  const missingTags = priorTags.filter((id) => id && !fullText.includes(id));
  if (missingTags.length === 0) return base;

  const lastAssistantIdx = [...base].map((m, idx) => (m.role === 'assistant' ? idx : -1)).filter((idx) => idx !== -1).pop();
  if (lastAssistantIdx === undefined) return base;

  base[lastAssistantIdx] = {
    role: 'assistant',
    content: `${base[lastAssistantIdx].content}\n${missingTags.map((id) => `[intencao_id: ${id}]`).join('\n')}`,
  };
  return base;
}

function appendGeneratedIntentId(
  responseText: string,
  tools?: AgentCoreInvocationResult['tools'],
): string {
  const intentTool = tools?.find((t) => t.name === 'registrar_intencao');
  const intencaoId =
    intentTool?.result && typeof intentTool.result === 'object'
      ? (intentTool.result as Record<string, unknown>).intencao_id
      : undefined;
  if (typeof intencaoId === 'string' && intencaoId.trim() && !responseText.includes(intencaoId.trim())) {
    return `${responseText}\n[intencao_id: ${intencaoId.trim()}]`;
  }
  return responseText;
}

/**
 * Handler linear da Lambda POST /chat (compatível com Response Streaming da AWS e testes locais).
 */
export function createStreamingChatHandler(
  deps?: ChatHandlerDependencies,
  onMetadata?: (meta: HttpMetadata) => void,
) {
  const activeStore =
    deps?.conversationsStore ??
    (docClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({})) as unknown as ConversationsStore);
  const agentInvoker = deps?.agentInvoker ?? createAwsAgentCoreInvoker();
  const nowFn = deps?.nowFn ?? (() => Date.now());

  return async (event: ApiGatewayProxyEvent, responseStream: WritableResponseStream): Promise<void> => {
    const corsHeaders = {
      'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN?.trim() || '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
    };

    const openStream = (statusCode: number, contentType: string) => {
      const meta: HttpMetadata = {
        statusCode,
        headers: { ...corsHeaders, 'Content-Type': contentType, 'Cache-Control': 'no-cache' },
      };
      onMetadata?.(meta);
      return getAwsLambdaGlobal()?.HttpResponseStream?.from(responseStream, meta) ?? responseStream;
    };

    const sendJsonError = (statusCode: number, error: string) => {
      const s = openStream(statusCode, 'application/json; charset=utf-8');
      s.write(JSON.stringify({ error }));
      s.end();
    };

    // 1. Autenticação: claim `sub` obrigatória do Cognito
    const usuarioId = extractJwtSub(event);
    if (!usuarioId) return sendJsonError(401, 'Não autorizado: identidade do usuário (claim sub) ausente no token JWT.');

    // 2. Validação da mensagem enviada pelo cliente
    const parsed = parseChatPayload(event);
    if (!parsed.ok) return sendJsonError(400, parsed.error);

    const conversasTable = process.env.CONVERSAS_TABLE_NAME?.trim();
    if (!conversasTable || (!deps?.agentInvoker && !process.env.AGENT_RUNTIME_ARN?.trim())) {
      console.error('Configuração ausente na Lambda /chat.');
      return sendJsonError(500, 'Serviço de chat temporariamente indisponível por configuração pendente.');
    }

    // 3. Abre stream HTTP 200 NDJSON
    const stream = openStream(200, 'application/x-ndjson; charset=utf-8');
    const emit = (payload: Record<string, unknown>) => stream.write(`${JSON.stringify(payload)}\n`);
    const sessionKey = `${usuarioId}:${parsed.rawSessionId}`;

    try {
      // 4. Lê histórico -> chama Agente -> envia cards de tools e resposta
      const existing = await activeStore.send(
        new GetCommand({ TableName: conversasTable, Key: { session_id: sessionKey } }),
      );
      const priorMessages =
        existing.Item?.usuario_id === usuarioId && Array.isArray(existing.Item.messages)
          ? (existing.Item.messages as Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>)
          : [];

      const history = enrichHistoryWithIntentIds(parsed.clientHistory, priorMessages);

      const agentResult = await agentInvoker.invokeAgent({
        prompt: parsed.prompt,
        usuarioId,
        sessionId: sessionKey,
        runtimeSessionId: toRuntimeSessionId(sessionKey),
        history,
      });

      for (const toolEvent of agentResult.tools ?? []) {
        emit({ tool: toolEvent });
      }
      if (agentResult.response.trim()) {
        emit({ message: { role: 'assistant', content: agentResult.response } });
      }

      // 5. Persiste conversa no DynamoDB (TTL 24h) e finaliza o stream
      const nowMs = nowFn();
      const nowIso = new Date(nowMs).toISOString();
      const assistantContentForDb = appendGeneratedIntentId(agentResult.response, agentResult.tools);
      await activeStore.send(
        new PutCommand({
          TableName: conversasTable,
          Item: {
            session_id: sessionKey,
            usuario_id: usuarioId,
            messages: [
              ...priorMessages,
              { role: 'user' as const, content: parsed.prompt, timestamp: nowIso },
              { role: 'assistant' as const, content: assistantContentForDb, timestamp: nowIso },
            ].slice(-MAX_MENSAGENS),
            updated_at: nowIso,
            expires_at: Math.floor(nowMs / 1000) + CONVERSA_TTL_SEGUNDOS,
          },
        }),
      );

      emit({ done: true });
    } catch (error) {
      console.error('Falha ao processar /chat:', error);
      emit({ error: 'Não foi possível processar sua mensagem no momento. Tente novamente.' });
    } finally {
      stream.end();
    }
  };
}

/**
 * Wrapper em buffer para testes unitários locais e fallback quando Response Streaming não está ativo.
 */
export function createChatHandler(deps?: ChatHandlerDependencies) {
  return async (event: ApiGatewayProxyEvent) => {
    let meta: HttpMetadata = { statusCode: 200, headers: {} };
    const chunks: string[] = [];
    const streaming = createStreamingChatHandler(deps, (m) => {
      meta = m;
    });
    await streaming(event, {
      write(chunk) {
        chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      },
      end() {},
    });
    return { statusCode: meta.statusCode, headers: meta.headers, body: chunks.join('') };
  };
}

const lambdaStreamify = getAwsLambdaGlobal()?.awslambda?.streamifyResponse;
export const handler = lambdaStreamify ? lambdaStreamify(createStreamingChatHandler()) : createChatHandler();
