import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { tool, type JSONValue, type ToolContext } from '@strands-agents/sdk';
import { z } from 'zod';
import { DEFAULT_AWS_REGION } from './prompt.js';

export type PaymentToolName = 'listar_catalogo' | 'registrar_intencao' | 'realizar_compra';

export interface ToolExecutionEvent {
  name: PaymentToolName;
  arguments: Record<string, unknown>;
  result?: unknown;
}

export interface LambdaInvoker {
  invoke<TResult = Record<string, unknown>>(
    functionName: string,
    payload: Record<string, unknown>,
  ): Promise<TResult>;
}

export interface CreatePaymentToolsOptions {
  readonly invoker?: LambdaInvoker;
  readonly onToolEvent?: (event: ToolExecutionEvent) => void;
}

interface RejectedToolResult {
  readonly status: 'recusado';
  readonly codigo: string;
  readonly erro: string;
  readonly mensagem: string;
}

const DOMAIN_VALIDATION_PREFIXES = [
  'Estoque insuficiente',
  'Produto não encontrado no catálogo oficial',
  'Parâmetro inválido',
];

const INTERNAL_SENSITIVE_PATTERN =
  /arn:aws:|\b\d{12}\b|AccessDeniedException|SyntaxError|ResourceNotFoundException|\bat\s+\S+\s*\(/i;

/**
 * Schemas Zod estritos para validação de entrada pelo Strands Agent SDK.
 */
export const ListarCatalogoSchema = z.object({
  categoria: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Categoria opcional para filtrar os produtos do catálogo (ex: consoles, headsets, teclados, mouses, jogos, monitores, acessorios).',
    ),
});

export const RegistrarIntencaoSchema = z.object({
  produto_id: z
    .string()
    .trim()
    .min(1)
    .describe('Identificador único do produto no catálogo oficial (ex: prod_001).'),
  quantidade: z
    .number()
    .int()
    .min(1)
    .describe('Quantidade inteira positiva do produto desejado.'),
});

export const RealizarCompraSchema = z.object({
  intencao_id: z
    .string()
    .trim()
    .min(1)
    .describe('Identificador da intenção de compra previamente registrada e pendente.'),
  metodo_pagamento: z
    .enum(['pix', 'cartao'])
    .describe('Método de pagamento confirmado explicitamente pelo cliente ("pix" ou "cartao").'),
});

/**
 * Cria o cliente AWS Lambda padrão para invocar as Tool Lambdas determinísticas.
 */
export function createAwsLambdaInvoker(region?: string): LambdaInvoker {
  const resolvedRegion =
    region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || DEFAULT_AWS_REGION;
  const client = new LambdaClient({ region: resolvedRegion });

  return {
    async invoke<TResult = Record<string, unknown>>(
      functionName: string,
      payload: Record<string, unknown>,
    ): Promise<TResult> {
      const response = await client.send(
        new InvokeCommand({
          FunctionName: functionName,
          Payload: Buffer.from(JSON.stringify(payload), 'utf8'),
        }),
      );

      const rawText = response.Payload ? Buffer.from(response.Payload).toString('utf8').trim() : '';
      const parsed = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};

      if (response.FunctionError) {
        const remoteMessage =
          typeof parsed.errorMessage === 'string' && parsed.errorMessage.trim().length > 0
            ? parsed.errorMessage.trim()
            : 'Falha na execução da função Lambda.';
        throw new Error(remoteMessage);
      }

      return parsed as TResult;
    },
  };
}

function resolveFunctionName(nameEnvKey: string, arnEnvKey: string, fallback: string): string {
  return process.env[nameEnvKey]?.trim() || process.env[arnEnvKey]?.trim() || fallback;
}

function resolveUsuarioId(context?: ToolContext): string | undefined {
  const raw = context?.invocationState?.usuarioId;
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Converte erros de invocação ou domínio em mensagens seguras em PT-BR sem vazar stack traces ou ARNs.
 */
export function sanitizeToolError(error: unknown): RejectedToolResult {
  const rawMessage = error instanceof Error ? error.message.trim() : '';
  const isSafeDomainMessage =
    rawMessage.length > 0 &&
    DOMAIN_VALIDATION_PREFIXES.some((prefix) => rawMessage.startsWith(prefix)) &&
    !INTERNAL_SENSITIVE_PATTERN.test(rawMessage);

  if (isSafeDomainMessage) {
    return {
      status: 'recusado',
      codigo: 'VALIDACAO_NEGOCIO',
      erro: 'VALIDACAO_NEGOCIO',
      mensagem: rawMessage,
    };
  }

  return {
    status: 'recusado',
    codigo: 'ERRO_PROCESSAMENTO',
    erro: 'ERRO_PROCESSAMENTO',
    mensagem:
      'Não foi possível concluir a operação nas ferramentas de pagamento no momento. Tente novamente em instantes.',
  };
}

function normalizeIntentResult(rawResult: Record<string, unknown>): Record<string, unknown> {
  if (rawResult.status === 'PENDENTE') {
    return {
      ...rawResult,
      status: 'pendente',
    };
  }
  return rawResult;
}

/**
 * Orquestra validação de identidade via invocationState, chamada Lambda, normalização e auditoria de eventos.
 */
async function executeLambdaTool(
  name: PaymentToolName,
  argsForEvent: Record<string, unknown>,
  functionName: string,
  buildPayload: (usuarioId: string) => Record<string, unknown>,
  context: ToolContext | undefined,
  invoker: LambdaInvoker,
  onToolEvent?: (event: ToolExecutionEvent) => void,
  transformResult?: (rawResult: Record<string, unknown>) => Record<string, unknown>,
): Promise<JSONValue> {
  const usuarioId = resolveUsuarioId(context);
  if (!usuarioId) {
    const rejected: RejectedToolResult = {
      status: 'recusado',
      codigo: 'USUARIO_NAO_AUTENTICADO',
      erro: 'USUARIO_NAO_AUTENTICADO',
      mensagem:
        'Identidade do usuário autenticado não encontrada na sessão. Faça login novamente.',
    };
    onToolEvent?.({ name, arguments: argsForEvent, result: rejected });
    return rejected as unknown as JSONValue;
  }

  try {
    const rawResult = await invoker.invoke<Record<string, unknown>>(
      functionName,
      buildPayload(usuarioId),
    );
    const normalized = transformResult ? transformResult(rawResult) : rawResult;
    onToolEvent?.({ name, arguments: argsForEvent, result: normalized });
    return normalized as JSONValue;
  } catch (error) {
    console.error(`Falha ao executar tool "${name}":`, error);
    const sanitized = sanitizeToolError(error);
    onToolEvent?.({ name, arguments: argsForEvent, result: sanitized });
    return sanitized as unknown as JSONValue;
  }
}

/**
 * Cria as 3 ferramentas do Strands Agent integradas às Lambdas determinísticas do Desafio 1.
 */
export function createPaymentTools(options?: CreatePaymentToolsOptions) {
  const invoker = options?.invoker ?? createAwsLambdaInvoker();
  const onToolEvent = options?.onToolEvent;

  const listarCatalogoTool = tool({
    name: 'listar_catalogo',
    description:
      'Lista os produtos oficiais da Nexus Store com preços e estoque e consulta o saldo disponível do cliente autenticado.',
    inputSchema: ListarCatalogoSchema,
    callback: async (input, context) =>
      executeLambdaTool(
        'listar_catalogo',
        input.categoria ? { categoria: input.categoria } : {},
        resolveFunctionName(
          'TOOL_CONSULTAR_SALDO_FUNCTION_NAME',
          'TOOL_CONSULTAR_SALDO_ARN',
          'alvaro-tool-consultar-saldo',
        ),
        (usuarioId) => ({
          usuario_id: usuarioId,
          ...(input.categoria ? { categoria: input.categoria } : {}),
        }),
        context,
        invoker,
        onToolEvent,
      ),
  });

  const registrarIntencaoTool = tool({
    name: 'registrar_intencao',
    description:
      'Registra uma intenção de compra pendente calculando o valor total no backend e reservando o resumo para confirmação explícita do cliente.',
    inputSchema: RegistrarIntencaoSchema,
    callback: async (input, context) =>
      executeLambdaTool(
        'registrar_intencao',
        { produto_id: input.produto_id, quantidade: input.quantidade },
        resolveFunctionName(
          'TOOL_CRIAR_INTENCAO_FUNCTION_NAME',
          'TOOL_CRIAR_INTENCAO_ARN',
          'alvaro-tool-criar-intencao',
        ),
        (usuarioId) => ({
          usuario_id: usuarioId,
          produto_id: input.produto_id,
          quantidade: input.quantidade,
        }),
        context,
        invoker,
        onToolEvent,
        normalizeIntentResult,
      ),
  });

  const realizarCompraTool = tool({
    name: 'realizar_compra',
    description:
      'Efetiva o pagamento de uma intenção pendente de forma atômica e idempotente após confirmação explícita do cliente com método "pix" ou "cartao".',
    inputSchema: RealizarCompraSchema,
    callback: async (input, context) =>
      executeLambdaTool(
        'realizar_compra',
        { intencao_id: input.intencao_id, metodo_pagamento: input.metodo_pagamento },
        resolveFunctionName(
          'TOOL_CONFIRMAR_PAGAMENTO_FUNCTION_NAME',
          'TOOL_CONFIRMAR_PAGAMENTO_ARN',
          'alvaro-tool-confirmar-pagamento',
        ),
        (usuarioId) => ({
          usuario_id: usuarioId,
          intencao_id: input.intencao_id,
          metodo_pagamento: input.metodo_pagamento,
        }),
        context,
        invoker,
        onToolEvent,
      ),
  });

  return [listarCatalogoTool, registrarIntencaoTool, realizarCompraTool] as [
    typeof listarCatalogoTool,
    typeof registrarIntencaoTool,
    typeof realizarCompraTool,
  ];
}
