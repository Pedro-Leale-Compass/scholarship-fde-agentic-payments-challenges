import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { Agent, BedrockModel, type MessageData } from '@strands-agents/sdk';
import { z } from 'zod';
import {
  DEFAULT_AWS_REGION,
  DEFAULT_BEDROCK_MODEL_ID,
  NEXUS_STORE_SYSTEM_PROMPT,
} from './prompt.js';
import { createPaymentTools, type ToolExecutionEvent } from './tools.js';

export const HistoryMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1),
});

export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;

/**
 * Schema validado para chamadas POST /invocations no contrato Bedrock AgentCore Runtime.
 */
export const InvocationPayloadSchema = z.object({
  prompt: z.string().trim().min(1, 'O campo "prompt" é obrigatório.'),
  usuarioId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  history: z.array(HistoryMessageSchema).optional(),
});

export type InvocationPayload = z.infer<typeof InvocationPayloadSchema>;

/**
 * Normaliza mensagens anteriores garantindo alternância estrita de papéis exigida pela Bedrock Converse API.
 */
export function buildSeedMessages(history?: readonly HistoryMessage[]): MessageData[] {
  if (!history || history.length === 0) {
    return [];
  }

  const merged: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const entry of history) {
    const text = entry.content.trim();
    if (!text) continue;

    // A Bedrock Converse API exige que o histórico comece sempre por uma fala do usuário.
    if (merged.length === 0 && entry.role === 'assistant') {
      continue;
    }

    const last = merged[merged.length - 1];
    if (last && last.role === entry.role) {
      last.content = `${last.content}\n\n${text}`;
    } else {
      merged.push({ role: entry.role, content: text });
    }
  }

  return merged.map((msg) => ({
    role: msg.role,
    content: [{ text: msg.content }],
  }));
}

export interface AgentTurnResult {
  response: string;
  stopReason?: string;
  tools?: ToolExecutionEvent[];
}

export type AgentRunner = (payload: InvocationPayload) => Promise<AgentTurnResult>;

function extractAssistantText(result: Awaited<ReturnType<Agent['invoke']>>): string {
  const blocks = result.lastMessage?.content ?? [];
  const textParts = blocks
    .flatMap((block) => (block.type === 'textBlock' ? [block.text.trim()] : []))
    .filter((text) => text.length > 0);

  if (textParts.length > 0) {
    return textParts.join('\n');
  }

  return result.toString().trim();
}

/**
 * Executa um turno do Strands Agent utilizando Bedrock (Claude Haiku em us-east-1).
 */
export async function runStrandsTurn(payload: InvocationPayload): Promise<AgentTurnResult> {
  const modelId = process.env.BEDROCK_MODEL_ID || DEFAULT_BEDROCK_MODEL_ID;
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || DEFAULT_AWS_REGION;

  const model = new BedrockModel({
    modelId,
    region,
  });

  const toolsUsed: ToolExecutionEvent[] = [];
  const tools = createPaymentTools({
    onToolEvent: (event) => toolsUsed.push(event),
  });

  const seedMessages = buildSeedMessages(payload.history);
  let effectivePrompt = payload.prompt;
  // Evita dois turnos consecutivos de 'user' na Bedrock Converse API caso a última entrada do seed seja 'user'.
  const lastSeed = seedMessages[seedMessages.length - 1];
  if (lastSeed && lastSeed.role === 'user') {
    const trailingUser = seedMessages.pop();
    const trailingText = trailingUser?.content
      .map((block) => ('text' in block ? block.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
    if (trailingText) {
      effectivePrompt = `${trailingText}\n\n${effectivePrompt}`;
    }
  }

  const agent = new Agent({
    model,
    systemPrompt: NEXUS_STORE_SYSTEM_PROMPT,
    tools,
    messages: seedMessages,
    printer: false,
  });

  // Mantém usuarioId/sessionId apenas no estado autenticado de invocação, nunca misturado ao prompt livre.
  const invokeOptions =
    payload.usuarioId || payload.sessionId
      ? {
          invocationState: {
            ...(payload.usuarioId ? { usuarioId: payload.usuarioId } : {}),
            ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
          },
        }
      : undefined;

  const result = await agent.invoke(effectivePrompt, invokeOptions);

  return {
    response: extractAssistantText(result),
    stopReason: result.stopReason,
    tools: toolsUsed,
  };
}

function parseRawJsonBody(rawBody: unknown): unknown {
  if (Buffer.isBuffer(rawBody)) {
    const text = rawBody.toString('utf8').trim();
    if (!text) {
      return null;
    }
    return JSON.parse(text);
  }
  if (typeof rawBody === 'string') {
    const text = rawBody.trim();
    if (!text) {
      return null;
    }
    return JSON.parse(text);
  }
  return rawBody;
}

/**
 * Cria a aplicação Express que implementa o contrato HTTP do Amazon Bedrock AgentCore Runtime:
 * - GET /ping -> status Healthy
 * - POST /invocations -> payload bruto/JSON e retorno sem exposição de stack trace
 */
export function createServer(runner: AgentRunner = runStrandsTurn): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/ping', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'Healthy',
      time_of_last_update: Math.floor(Date.now() / 1000),
    });
  });

  app.post(
    '/invocations',
    express.raw({ type: '*/*', limit: '2mb' }),
    async (req: Request, res: Response) => {
      let parsedBody: unknown;
      try {
        parsedBody = parseRawJsonBody(req.body);
      } catch {
        res.status(400).json({
          error: 'Corpo da requisição deve ser um JSON válido.',
        });
        return;
      }

      const validation = InvocationPayloadSchema.safeParse(parsedBody);
      if (!validation.success) {
        res.status(400).json({
          error: 'Payload inválido. Informe um campo "prompt" não vazio.',
        });
        return;
      }

      try {
        const result = await runner(validation.data);
        res.status(200).json({
          response: result.response,
          stopReason: result.stopReason,
          tools: result.tools ?? [],
        });
      } catch (error) {
        console.error('Erro interno ao processar /invocations:', error);
        res.status(500).json({
          error: 'Não foi possível processar sua solicitação no momento. Tente novamente em instantes.',
        });
      }
    },
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const statusCode =
      typeof err === 'object' &&
      err !== null &&
      'status' in err &&
      typeof (err as { status: unknown }).status === 'number'
        ? (err as { status: number }).status
        : 400;

    res.status(statusCode).json({
      error:
        statusCode === 413
          ? 'O tamanho da requisição excede o limite suportado.'
          : 'Requisição inválida.',
    });
  });

  return app;
}
