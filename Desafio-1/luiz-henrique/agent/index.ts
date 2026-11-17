/**
 * Agente Strands no AgentCore Runtime — Desafio 1 (luiz-henrique).
 *
 * Usa bedrock-agentcore SDK (BedrockAgentCoreApp) + @strands-agents/sdk.
 * Mesmo código roda local e na AWS, sempre com Amazon Bedrock (Claude Haiku):
 *   - Local:  `npm run dev` → BedrockAgentCoreApp na porta 3031, usando o perfil AWS do desenvolvedor
 *   - Remoto: container no AgentCore Runtime via CDK (CfnAgentRuntime)
 *
 * As 3 tools invocam as respectivas Lambdas. Quando os ARNs não estão configurados
 * (desenvolvimento local sem stack implantada), usam um fallback em memória com as
 * mesmas regras de negócio.
 */

import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { Agent, BedrockModel, ZodTool } from '@strands-agents/sdk';
import { z } from 'zod';
import {
  LambdaClient,
  InvokeCommand,
  type InvokeCommandInput,
} from '@aws-sdk/client-lambda';

// Carrega variáveis de ambiente do .env (ignorado pelo git) se existir.
await import('dotenv').then((m) => m.config?.({ override: true }));

// Modelo temporário: Nova 2 Lite (barato e com tool use). O alvo do desafio é
// Claude Haiku; troque via BEDROCK_MODEL_ID quando o acesso ao modelo for liberado:
//   us.anthropic.claude-haiku-4-5-20251001-v1:0
const MODEL_ID = process.env.BEDROCK_MODEL_ID || 'global.amazon.nova-2-lite-v1:0';
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const LIMITE_COMPRA = Number(process.env.LIMITE_COMPRA) || 500;

const lambdaClient = new LambdaClient({ region: REGION });

const TOOL_LISTAR_CATALOGO_ARN = process.env.TOOL_LISTAR_CATALOGO_ARN;
const TOOL_REGISTRAR_INTENCAO_ARN = process.env.TOOL_REGISTRAR_INTENCAO_ARN;
const TOOL_REALIZAR_COMPRA_ARN = process.env.TOOL_REALIZAR_COMPRA_ARN;

// --- Fallback local (sem Lambdas implantadas) ---

interface Produto {
  id: string;
  nome: string;
  preco: number;
}

interface Intencao {
  intencao_id: string;
  usuario_id: string;
  produtos: Produto[];
  valor: number;
  status: 'pendente' | 'paga';
  forma_pagamento?: 'cartao' | 'pix';
}

const CATALOGO_LOCAL: Produto[] = [
  { id: 'p1', nome: 'Fone Bluetooth', preco: 199.9 },
  { id: 'p2', nome: 'Teclado Mecânico', preco: 349.9 },
  { id: 'p3', nome: 'Mouse Gamer', preco: 129.9 },
  { id: 'p4', nome: 'Monitor 27"', preco: 1299.0 },
  { id: 'p5', nome: 'Webcam Full HD', preco: 299.0 },
  { id: 'p6', nome: 'Cadeira Gamer', preco: 1499.0 },
  { id: 'p7', nome: 'Headset com Microfone', preco: 249.9 },
  { id: 'p8', nome: 'Suporte para Monitor', preco: 149.0 },
];

const intencoesLocal = new Map<string, Intencao>();

function listarCatalogoLocal() {
  return { ok: true, catalogo: CATALOGO_LOCAL, count: CATALOGO_LOCAL.length };
}

function registrarIntencaoLocal(usuario_id: string, produtos: Produto[], valor: number) {
  const intencao_id = `int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  intencoesLocal.set(intencao_id, {
    intencao_id,
    usuario_id,
    produtos,
    valor,
    status: 'pendente',
  });
  return {
    ok: true,
    intencao_id,
    usuario_id,
    produtos,
    valor,
    status: 'pendente',
    message: 'Intencao registrada com sucesso',
  };
}

function realizarCompraLocal(usuario_id: string, intencao_id: string, forma_pagamento: 'cartao' | 'pix') {
  const intencao = intencoesLocal.get(intencao_id);
  if (!intencao) {
    return { ok: false, error: 'intencao_id invalido: intencao nao encontrada' };
  }
  if (intencao.usuario_id !== usuario_id) {
    return { ok: false, error: 'intencao nao pertence ao usuario' };
  }
  if (intencao.status !== 'pendente') {
    return { ok: false, error: `intencao ja esta em status: ${intencao.status}` };
  }
  if (intencao.valor > LIMITE_COMPRA) {
    return {
      ok: false,
      error: `limite excedido: valor ${intencao.valor} acima do limite de ${LIMITE_COMPRA}`,
    };
  }
  intencao.status = 'paga';
  intencao.forma_pagamento = forma_pagamento;
  return {
    ok: true,
    intencao_id,
    usuario_id,
    valor: intencao.valor,
    forma_pagamento,
    status: 'paga',
    message: 'Compra realizada com sucesso',
  };
}

async function invokeLambda(functionArn: string | undefined, payload: Record<string, unknown>): Promise<unknown> {
  if (!functionArn) {
    throw new Error('tool Lambda ARN not configured');
  }

  const input: InvokeCommandInput = {
    FunctionName: functionArn,
    InvocationType: 'RequestResponse',
    Payload: JSON.stringify(payload),
  };
  const result = await lambdaClient.send(new InvokeCommand(input));
  const decoded = result.Payload ? new TextDecoder().decode(result.Payload) : '{}';
  const parsed = JSON.parse(decoded);
  if (typeof parsed === 'object' && parsed !== null && 'body' in parsed) {
    try {
      return JSON.parse(String(parsed.body));
    } catch (_) {
      return parsed.body;
    }
  }
  return parsed;
}

// --- Agent por requisição (usuario_id vem sempre do contexto do servidor) ---

interface PurchaseResult {
  ok: boolean;
  code?: string;
  intencao_id?: string;
  status?: string;
  valor?: number;
}

interface AgentState {
  lastPurchase: PurchaseResult | null;
  lastIntencaoId: string | null;
}

const SUCCESS_REPLY =
  /(compra\s+(?:foi\s+)?(?:realizada|confirmada|aprovada|conclu[ií]da|finalizada|efetuada)|pagamento\s+(?:aprovado|confirmado|realizado)|compra\s+aprovada)/i;

function normalizePurchase(result: unknown): PurchaseResult {
  const r = (result ?? {}) as {
    ok?: unknown;
    code?: unknown;
    intencao_id?: unknown;
    status?: unknown;
    valor?: unknown;
  };
  return {
    ok: r.ok === true,
    code: typeof r.code === 'string' ? r.code : undefined,
    intencao_id: typeof r.intencao_id === 'string' ? r.intencao_id : undefined,
    status: typeof r.status === 'string' ? r.status : undefined,
    valor: typeof r.valor === 'number' ? r.valor : undefined,
  };
}

/**
 * Impede que o modelo afirme "compra aprovada" sem que realizar_compra tenha
 * retornado ok: true nesta mesma invocação. É uma rede de segurança determinística
 * contra alucinação de sucesso.
 */
function applyPurchaseGuard(
  reply: string,
  purchase: PurchaseResult | null,
): string {
  if (!SUCCESS_REPLY.test(reply)) return reply;
  if (purchase?.ok === true) return reply;

  const reason =
    purchase && purchase.ok === false && purchase.code
      ? `O pagamento não foi concluído (${purchase.code}). `
      : '';
  return (
    `${reason}A compra ainda não foi finalizada e nenhuma cobrança foi confirmada. ` +
    'Se quiser, registro a intenção e aguardo a forma de pagamento para finalizar.'
  );
}

const INTENCAO_ID_ANY_RE =
  /\b(?:INT-[0-9A-F]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
const INTENCAO_ID_RE =
  /^(?:INT-[0-9A-F]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const PLACEHOLDER_INTENCAO_RE = /\bintencao[_-]?\d+\b/gi;
const SHORT_INTENCAO_RE = /\bINT-[0-9A-Z]+\b/gi;
const PAYMENT_CONFIRM_RE =
  /^(pode\s+)?(confirmar|confirmo|pagar|pode\s+ser|finalizar|fechar|cart[aã]o|pix|sim)\b|.*\b(pagar|confirmar|finalizar|fechar)\b.*\b(cart[aã]o|pix)\b/i;

function paymentMethod(text: string): 'cartao' | 'pix' | null {
  if (/pix/i.test(text)) return 'pix';
  if (/cart[aã]o/i.test(text)) return 'cartao';
  return null;
}

function purchaseFallbackMessage(
  purchase: PurchaseResult,
  intencaoId: string,
  method: 'cartao' | 'pix',
): string {
  if (purchase.ok) {
    const valor =
      purchase.valor !== undefined
        ? ` no valor de R$ ${purchase.valor.toFixed(2)}`
        : '';
    return `Compra aprovada${valor}! Intenção ${intencaoId}, pagamento via ${
      method === 'pix' ? 'pix' : 'cartão'
    }.`;
  }
  const reason = purchase.code
    ? `Motivo: ${purchase.code}.`
    : 'Não foi possível confirmar o pagamento.';
  return `O pagamento não foi concluído. ${reason} A intenção continua pendente e nenhuma cobrança foi confirmada.`;
}

/**
 * Quando o usuário confirma o pagamento e o modelo não chama realizar_compra,
 * o runtime executa a ferramenta com o último intencao_id da conversa. Evita que
 * a compra fique pendente por uma omissão do modelo.
 */
async function completePaymentFallback(
  usuarioId: string,
  state: AgentState,
  prompt: string,
): Promise<string | null> {
  const lastUserLine =
    prompt
      .split('\n')
      .filter((line) => /^user:/i.test(line))
      .pop() || '';
  if (!PAYMENT_CONFIRM_RE.test(lastUserLine)) return null;

  const method = paymentMethod(lastUserLine);
  if (!method) return null;

  const ids = prompt.match(INTENCAO_ID_ANY_RE) || [];
  const intencaoId = state.lastIntencaoId || ids[ids.length - 1];
  if (!intencaoId) return null;

  let result: unknown;
  if (!TOOL_REALIZAR_COMPRA_ARN) {
    result = realizarCompraLocal(usuarioId, intencaoId, method);
  } else {
    result = await invokeLambda(TOOL_REALIZAR_COMPRA_ARN, {
      usuario_id: usuarioId,
      intencao_id: intencaoId,
      forma_pagamento: method,
    });
  }

  const purchase = normalizePurchase(result);
  state.lastPurchase = purchase;
  return purchaseFallbackMessage(purchase, intencaoId, method);
}

function createAgent(
  usuario_id: string,
  ultimaIntencaoId?: string,
): { agent: Agent; state: AgentState } {
  const state: AgentState = {
    lastPurchase: null,
    lastIntencaoId:
      ultimaIntencaoId && INTENCAO_ID_RE.test(ultimaIntencaoId)
        ? ultimaIntencaoId
        : null,
  };
  const listarCatalogoTool = new ZodTool({
    name: 'listar_catalogo',
    description:
      'Lista todos os produtos da loja com id, nome e preço. Use quando o usuário pedir catálogo, produtos ou preços.',
    inputSchema: z.object({}),
    callback: async () => {
      if (!TOOL_LISTAR_CATALOGO_ARN) return listarCatalogoLocal();
      return invokeLambda(TOOL_LISTAR_CATALOGO_ARN, {});
    },
  });

  const   registrarIntencaoTool = new ZodTool({
    name: 'registrar_intencao',
    description:
      'Registra uma intenção de compra (status pendente) e devolve intencao_id. NÃO confirma pagamento. Use assim que o usuário escolher os produtos.',
    inputSchema: z.object({
      produtos: z.array(
        z.object({ id: z.string(), nome: z.string(), preco: z.number() })
      ).describe('Lista de produtos desejados'),
      valor: z.number().describe('Valor total da compra'),
    }),
    callback: async ({ produtos, valor }) => {
      let result: unknown;
      if (!TOOL_REGISTRAR_INTENCAO_ARN) {
        result = registrarIntencaoLocal(usuario_id, produtos, valor);
      } else {
        result = await invokeLambda(TOOL_REGISTRAR_INTENCAO_ARN, {
          usuario_id,
          produtos,
          valor,
        });
      }
      const r = (result ?? {}) as { intencao_id?: unknown };
      if (typeof r.intencao_id === 'string') state.lastIntencaoId = r.intencao_id;
      return result;
    },
  });

  const realizarCompraTool = new ZodTool({
    name: 'realizar_compra',
    description:
      'Paga uma intenção pendente com cartao ou pix. É a única ferramenta que confirma compra: só retorne sucesso se ela responder ok: true.',
    inputSchema: z.object({
      intencao_id: z.string().describe('ID da intenção de compra'),
      forma_pagamento: z.enum(['cartao', 'pix']).describe('Forma de pagamento: cartao ou pix'),
    }),
    callback: async ({ intencao_id, forma_pagamento }) => {
      // O modelo às vezes inventa um ID (ex.: "intencao_1"). Se houver um ID real
      // registrado nesta invocação, use ele; caso contrário, recuse sem chamar a tool.
      let id = intencao_id;
      if (!INTENCAO_ID_RE.test(id) && state.lastIntencaoId) {
        id = state.lastIntencaoId;
      }
      // Se uma intenção acabou de ser registrada nesta invocação, ela é a que
      // vale; ignora UUIDs divergentes inventados pelo modelo.
      if (
        state.lastIntencaoId &&
        id.toLowerCase() !== state.lastIntencaoId.toLowerCase()
      ) {
        id = state.lastIntencaoId;
      }
      if (!INTENCAO_ID_RE.test(id)) {
        const result = {
          ok: false,
          code: 'INTENCAO_INVALIDA',
          error:
            'intencao_id deve ser o UUID retornado por registrar_intencao. Registre a intenção novamente.',
        };
        state.lastPurchase = normalizePurchase(result);
        return result;
      }

      let result: unknown;
      if (!TOOL_REALIZAR_COMPRA_ARN) {
        result = realizarCompraLocal(usuario_id, id, forma_pagamento);
      } else {
        result = await invokeLambda(TOOL_REALIZAR_COMPRA_ARN, {
          usuario_id,
          intencao_id: id,
          forma_pagamento,
        });
      }
      state.lastPurchase = normalizePurchase(result);
      return result;
    },
  });

  return {
    state,
    agent: new Agent({
      model: new BedrockModel({
        modelId: MODEL_ID,
        region: REGION,
        temperature: 0,
      }),
      tools: [listarCatalogoTool, registrarIntencaoTool, realizarCompraTool],
      systemPrompt: `
Você é o vendedor da loja de eletrônicos. Atenda em pt-BR, curto e direto.

## Escopo
Fale só da loja: catálogo, preços, disponibilidade e compras. Fora disso, diga que só ajuda com a loja.

## Ferramentas
- listar_catalogo: catálogo e preços.
- registrar_intencao: cria uma intenção pendente e devolve intencao_id. Nunca confirma pagamento.
- realizar_compra: paga a intenção com cartão ou pix. Só ela confirma compra.

## Fluxo
1. Usuário pede produto/preço → listar_catalogo.
2. Usuário escolhe produto → registrar_intencao agora. Mostre o intencao_id retornado e pergunte: cartão ou pix?
3. Usuário responde cartão/pix → realizar_compra com esse intencao_id.
4. Responda com o retorno:
   - ok: true → "Compra aprovada" + valor, forma e intencao_id.
   - ok: false → explique o code e o próximo passo.

## Regras
- Nunca invente id, preço ou status. Copie o intencao_id da ferramenta.
- Só diga "aprovada", "confirmada" ou "paga" se realizar_compra retornou ok: true.
- Responda só à última mensagem. Nunca escreva "user:" ou "assistant:".
- Uma ferramenta por vez.
- Preço em R$ 0,00.
- O usuário autenticado é ${usuario_id}; não peça usuario_id.

## Exemplo
Usuário: Quero comprar o Fone Bluetooth.
Você: Intenção INT-1A2B3C4D registrada: Fone Bluetooth, R$ 199,90, pendente. Cartão ou pix?
Usuário: Pix.
Você: Compra aprovada! Fone Bluetooth, R$ 199,90, pix, intenção INT-1A2B3C4D.
`.trim(),
    }),
  };
}

// --- BedrockAgentCoreApp (local dev + AgentCore Runtime compatible) ---

interface AgentRequest {
  prompt?: unknown;
  usuario_id?: unknown;
  messages?: unknown;
  intencao_id?: unknown;
}

function toConversation(
  messages: unknown,
): Array<{ role: 'user' | 'assistant'; content: Array<{ text: string }> }> {
  if (!Array.isArray(messages)) return [];
  const out: Array<{
    role: 'user' | 'assistant';
    content: Array<{ text: string }>;
  }> = [];
  for (const item of messages) {
    const role = (item as { role?: unknown })?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = (item as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .map((block) =>
        typeof (block as { text?: unknown })?.text === 'string'
          ? (block as { text: string }).text
          : '',
      )
      .join(' ')
      .trim();
    if (!text) continue;
    out.push({ role, content: [{ text }] });
  }
  return out;
}

const FAKE_TURN_RE = /^\s*(?:[-*]\s*)?(?:user|assistant|human|ai|system)\s*:/i;

/**
 * Remove transcrições fabricadas pelo modelo. Quando o histórico chega como texto
 * achatado, Claude pode continuar o transcript e gerar falas do usuário; isso corta
 * a resposta no primeiro turno falso.
 */
function stripFabricatedTurns(reply: string): string {
  const lines = reply.split('\n');
  const index = lines.findIndex((line) => FAKE_TURN_RE.test(line));
  if (index === -1) return reply;
  if (index === 0) {
    return 'Não consegui processar a última mensagem. Pode repetir, por favor?';
  }
  return (
    lines.slice(0, index).join('\n').trim() ||
    'Não foi possível gerar uma resposta.'
  );
}

/**
 * Impede IDs inventados na resposta: qualquer UUID diferente do último
 * intencao_id real vira o ID real; placeholders como "intencao_1" também.
 */
function groundIntencaoIds(reply: string, realId: string | null): string {
  if (!realId) return reply;
  const real = realId.toLowerCase();
  let changed = false;

  let out = reply.replace(INTENCAO_ID_ANY_RE, (id) => {
    if (id.toLowerCase() === real) return id;
    changed = true;
    return realId;
  });
  out = out.replace(PLACEHOLDER_INTENCAO_RE, () => {
    changed = true;
    return realId;
  });
  out = out.replace(SHORT_INTENCAO_RE, (id) => {
    if (id.toUpperCase() === realId.toUpperCase()) return id;
    changed = true;
    return realId;
  });

  return changed ? out : reply;
}

function jsonError(
  statusCode: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): string {
  return JSON.stringify({
    statusCode,
    body: { ok: false, code, error: message, ...extra },
  });
}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    // No requestSchema here on purpose: the SDK answers schema failures with a
    // JSON object, which Fastify/SSE cannot serialize and turns into an opaque
    // 500. Validate in the handler and always answer with a JSON string.
    process: async (request) => {
      const payload = (request ?? {}) as AgentRequest;
      const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
      const usuario_id =
        typeof payload.usuario_id === 'string' ? payload.usuario_id.trim() : '';

      const missing = [
        prompt.length > 0 ? null : 'prompt',
        usuario_id.length > 0 ? null : 'usuario_id',
      ].filter((field): field is string => field !== null);

      if (missing.length > 0) {
        return jsonError(
          400,
          'invalid_request',
          `missing or blank required field(s): ${missing.join(', ')}`,
          { required: { prompt: 'non-blank string', usuario_id: 'non-blank string' } },
        );
      }

      try {
        const { agent, state } = createAgent(
          usuario_id,
          typeof payload.intencao_id === 'string'
            ? payload.intencao_id
            : undefined,
        );
        const conversation = toConversation(payload.messages);
        const chunks: string[] = [];
        for await (const event of agent.stream(
          conversation.length > 0 ? conversation : prompt,
        )) {
          if (event.type === 'contentBlockEvent') {
            const block = event.contentBlock;
            if ((block as { type?: string }).type === 'textBlock') {
              chunks.push((block as { text?: string }).text || '');
            }
          }
        }

        const rawReply =
          chunks.join('').trim() || 'Não foi possível gerar uma resposta.';
        const sanitized = stripFabricatedTurns(rawReply);
        if (sanitized !== rawReply) {
          console.log(JSON.stringify({ guard: 'fabricated_turn_removed' }));
        }
        const grounded = groundIntencaoIds(sanitized, state.lastIntencaoId);
        if (grounded !== sanitized) {
          console.log(
            JSON.stringify({
              guard: 'intencao_id_grounded',
              intencao_id: state.lastIntencaoId,
            }),
          );
        }
        let reply = applyPurchaseGuard(grounded, state.lastPurchase);

        if (!state.lastPurchase) {
          try {
            const fallback = await completePaymentFallback(
              usuario_id,
              state,
              prompt,
            );
            if (fallback) {
              reply = fallback;
              console.log(
                JSON.stringify({
                  guard: 'payment_fallback',
                  purchase: state.lastPurchase,
                }),
              );
            }
          } catch (err) {
            console.error('payment fallback error:', err);
          }
        }

        if (reply !== rawReply) {
          console.log(
            JSON.stringify({
              guard: 'purchase_reply_adjusted',
              purchase: state.lastPurchase,
            }),
          );
        }

        return JSON.stringify({
          ok: true,
          usuario_id,
          reply,
          purchase: state.lastPurchase,
          intencao_id: state.lastIntencaoId,
          model: MODEL_ID,
        });
      } catch (err) {
        console.error('agent invocation error:', err);
        return jsonError(
          502,
          'agent_error',
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  },
});

app.run({ port: Number(process.env.PORT) || 3031 });

export { app, createAgent };
