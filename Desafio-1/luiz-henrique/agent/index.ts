/**
 * Agente Strands no AgentCore Runtime — Desafio 1 (luiz-henrique).
 *
 * Usa bedrock-agentcore SDK (BedrockAgentCoreApp) + @strands-agents/sdk.
 * Mesmo código roda local e na AWS, sempre com Amazon Bedrock (Claude Haiku):
 *   - Local:  `npm run dev:agent` → BedrockAgentCoreApp na porta 3031, usando o perfil AWS do desenvolvedor
 *   - Remoto: container no AgentCore Runtime via CDK (CustomResource)
 *
 * As 3 tools invocam as respectivas Lambdas. Quando os ARNs não estão configurados
 * (desenvolvimento local sem stack implantada), usam um fallback em memória que
 * replica os contratos das Lambdas (IDs, códigos de erro, status, expiração e saldo).
 */

import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { Agent, BedrockModel, ZodTool } from '@strands-agents/sdk';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import {
  LambdaClient,
  InvokeCommand,
  type InvokeCommandInput,
} from '@aws-sdk/client-lambda';

// Carrega o .env da raiz do projeto (ignorado pelo git) quando rodando local.
// No container, o arquivo normalmente não existe e as variáveis vêm do runtime.
const HERE = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(HERE, '..', '.env'), override: true });

// Se o shell já exportou credenciais temporárias (aws-creds.sh), elas vencem o
// AWS_PROFILE do .env. Sem isso, o SDK tenta resolver o perfil SSO e falha.
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SESSION_TOKEN) {
  delete process.env.AWS_PROFILE;
}

const MODEL_ID = process.env.BEDROCK_MODEL_ID || 'global.amazon.nova-2-lite-v1:0';
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const SALDO_INICIAL_LOCAL = Number(process.env.SALDO_INICIAL_LOCAL ?? process.env.LIMITE_COMPRA) || 500;

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
  valor_centavos: number;
  status: 'pendente' | 'paga' | 'cancelada';
  expira_em: string;
  created_at: string;
  forma_pagamento?: 'cartao' | 'pix';
  motivo_falha?: string;
  pago_em?: string;
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

const EXPIRACAO_MINUTOS = 15;
const intencoesLocal = new Map<string, Intencao>();
const saldosLocal = new Map<string, number>();
const gastosLocal = new Map<string, number>();

function gerarIntencaoIdLocal(): string {
  return `INT-${randomBytes(4).toString('hex').toUpperCase()}`;
}

function saldoLocal(usuario_id: string): number {
  const atual = saldosLocal.get(usuario_id);
  if (atual !== undefined) return atual;
  const inicial = Math.round(SALDO_INICIAL_LOCAL * 100);
  saldosLocal.set(usuario_id, inicial);
  return inicial;
}

function listarCatalogoLocal() {
  return { ok: true, catalogo: CATALOGO_LOCAL, count: CATALOGO_LOCAL.length };
}

function registrarIntencaoLocal(usuario_id: string, produtos: Produto[], valor: number) {
  const intencao_id = gerarIntencaoIdLocal();
  const valor_centavos = Math.round(valor * 100);
  const created_at = new Date().toISOString();
  const expira_em = new Date(
    Date.now() + EXPIRACAO_MINUTOS * 60 * 1000,
  ).toISOString();
  intencoesLocal.set(intencao_id, {
    intencao_id,
    usuario_id,
    produtos,
    valor,
    valor_centavos,
    status: 'pendente',
    expira_em,
    created_at,
  });
  return {
    ok: true,
    intencao_id,
    usuario_id,
    produtos,
    valor,
    valor_centavos,
    status: 'pendente',
    expira_em,
    message: 'Intencao registrada com sucesso',
  };
}

function realizarCompraLocal(
  usuario_id: string,
  intencao_id: string,
  forma_pagamento: 'cartao' | 'pix',
) {
  const intencao = intencoesLocal.get(intencao_id);
  if (!intencao) {
    return {
      ok: false,
      code: 'INTENCAO_INVALIDA',
      error: 'intencao_id invalido: intencao nao encontrada',
    };
  }
  if (intencao.usuario_id !== usuario_id) {
    return {
      ok: false,
      code: 'INTENCAO_INVALIDA',
      error: 'intencao_id invalido: intencao nao encontrada',
    };
  }
  if (intencao.status !== 'pendente') {
    const code =
      intencao.status === 'paga'
        ? 'INTENCAO_JA_PAGA'
        : intencao.status === 'cancelada'
          ? 'INTENCAO_CANCELADA'
          : 'INTENCAO_INDISPONIVEL';
    return {
      ok: false,
      code,
      error: `intencao ja esta em status: ${intencao.status}`,
      status: intencao.status,
    };
  }
  if (new Date(intencao.expira_em).getTime() <= Date.now()) {
    intencao.status = 'cancelada';
    intencao.motivo_falha = 'INTENCAO_EXPIRADA';
    return {
      ok: false,
      code: 'INTENCAO_EXPIRADA',
      error: 'intencao expirada: registre uma nova intencao',
      intencao_id,
      status: 'cancelada',
    };
  }
  const valorCentavos = intencao.valor_centavos;
  const saldo = saldoLocal(usuario_id);
  if (valorCentavos > saldo) {
    intencao.status = 'cancelada';
    intencao.motivo_falha = 'LIMITE_EXCEDIDO';
    return {
      ok: false,
      code: 'LIMITE_EXCEDIDO',
      error: 'limite excedido: saldo disponivel insuficiente para esta compra',
      intencao_id,
      status: 'cancelada',
    };
  }
  saldosLocal.set(usuario_id, saldo - valorCentavos);
  gastosLocal.set(
    usuario_id,
    (gastosLocal.get(usuario_id) || 0) + valorCentavos,
  );
  intencao.status = 'paga';
  intencao.forma_pagamento = forma_pagamento;
  intencao.pago_em = new Date().toISOString();
  return {
    ok: true,
    code: 'COMPRA_APROVADA',
    intencao_id,
    usuario_id,
    valor: intencao.valor,
    valor_centavos: valorCentavos,
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
  registeredIntencaoId: string | null;
  registeredThisTurn: boolean;
  verifiedPendingId: string | null;
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

  if (purchase && purchase.ok === false && purchase.code) {
    return `Erro: o agente não concluiu a compra (${purchase.code}). Nenhuma cobrança foi confirmada.`;
  }
  return 'Erro: o agente iria confirmar a compra para você sem registrar no backend. Nenhuma cobrança foi confirmada.';
}

const INTENCAO_ID_RE =
  /^(?:INT-[0-9A-F]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
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

  const code = purchase.code || 'ERRO_DESCONHECIDO';
  const explica: Record<string, string> = {
    LIMITE_EXCEDIDO:
      'o limite/saldo foi excedido; a intenção foi cancelada. Registre uma nova intenção ou escolha outro produto.',
    INTENCAO_CANCELADA:
      'a intenção já estava cancelada. Registre uma nova intenção.',
    INTENCAO_EXPIRADA:
      'a intenção expirou. Registre uma nova intenção.',
    INTENCAO_JA_PAGA:
      'a intenção já foi paga. Registre uma nova intenção para outro produto.',
    INTENCAO_INDISPONIVEL:
      'a intenção não está mais pendente. Registre uma nova intenção.',
    INTENCAO_INVALIDA:
      'o ID da intenção não é válido. Registre a intenção novamente.',
    METODO_INVALIDO: 'a forma de pagamento deve ser cartão ou pix.',
    USUARIO_NAO_ENCONTRADO: 'o usuário não foi encontrado no cadastro.',
  };
  return `O pagamento não foi concluído (${code}): ${
    explica[code] || 'não foi possível concluir a compra.'
  } Nenhuma cobrança foi confirmada.`;
}

/**
 * Rede de segurança determinística: se o usuário confirmar cartão/pix e o modelo
 * não tiver chamado realizar_compra, paga apenas o ID pendente verificado pela API
 * na conversa. Nunca usa IDs do histórico/prompt.
 */
async function completePaymentFallback(
  usuarioId: string,
  state: AgentState,
  lastUserText: string,
): Promise<string | null> {
  if (!state.verifiedPendingId) return null;
  if (!PAYMENT_CONFIRM_RE.test(lastUserText)) return null;
  const method = paymentMethod(lastUserText);
  if (!method) return null;

  let result: unknown;
  if (!TOOL_REALIZAR_COMPRA_ARN) {
    result = realizarCompraLocal(usuarioId, state.verifiedPendingId, method);
  } else {
    result = await invokeLambda(TOOL_REALIZAR_COMPRA_ARN, {
      usuario_id: usuarioId,
      intencao_id: state.verifiedPendingId,
      forma_pagamento: method,
    });
  }

  const purchase = normalizePurchase(result);
  state.lastPurchase = purchase;
  return purchaseFallbackMessage(purchase, state.verifiedPendingId, method);
}

const REGISTRATION_REPLY_RE =
  /(inten[çc][ãa]o\s+(?:foi\s+)?(?:registrada|criada)|registrei\s+(?:a\s+)?inten[çc][ãa]o)/i;
/**
 * Impede que o modelo afirme que registrou uma intenção sem que registrar_intencao
 * tenha retornado ok: true nesta mesma invocação. Não reescreve IDs para outro
 * valor: a falha fica visível para o usuário.
 */
function applyRegistrationGuard(
  reply: string,
  state: AgentState,
): string {
  if (!REGISTRATION_REPLY_RE.test(reply)) return reply;
  if (state.registeredThisTurn) return reply;
  return 'Não registrei nenhuma intenção nesta mensagem (nenhum ID foi criado). Nenhuma cobrança foi feita. Pode repetir qual produto você quer comprar?';
}

function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

async function fetchCatalogo(): Promise<Produto[]> {
  if (!TOOL_LISTAR_CATALOGO_ARN) return CATALOGO_LOCAL;
  try {
    const result = (await invokeLambda(TOOL_LISTAR_CATALOGO_ARN, {})) as {
      catalogo?: unknown;
    };
    if (Array.isArray(result.catalogo)) return result.catalogo as Produto[];
  } catch (err) {
    console.error('registration fallback: catalog error:', err);
  }
  return CATALOGO_LOCAL;
}

function encontrarProduto(text: string, catalogo: Produto[]): Produto | null {
  const normalized = normalizeText(text);
  const matches = catalogo.filter((produto) =>
    normalized.includes(normalizeText(produto.nome)),
  );
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Rede de segurança para a omissão mais comum do modelo: ele diz "intenção
 * registrada" sem chamar a tool. Se a última mensagem do usuário citar exatamente
 * um produto conhecido, registra esse produto na tool real e devolve o ID/preço
 * retornados pelo backend. Não inventa ID nem preço.
 */
async function completeRegistrationFallback(
  usuarioId: string,
  state: AgentState,
  lastUserText: string,
  reply: string,
): Promise<string | null> {
  if (state.registeredThisTurn) return null;
  if (!REGISTRATION_REPLY_RE.test(reply)) return null;

  const catalogo = await fetchCatalogo();
  const produto = encontrarProduto(lastUserText, catalogo);
  if (!produto) return null;

  let result: unknown;
  if (!TOOL_REGISTRAR_INTENCAO_ARN) {
    result = registrarIntencaoLocal(usuarioId, [produto], produto.preco);
  } else {
    result = await invokeLambda(TOOL_REGISTRAR_INTENCAO_ARN, {
      usuario_id: usuarioId,
      produtos: [produto],
      valor: produto.preco,
    });
  }

  const r = (result ?? {}) as {
    ok?: unknown;
    intencao_id?: unknown;
    valor?: unknown;
  };
  if (r.ok !== true || typeof r.intencao_id !== 'string') return null;

  state.registeredIntencaoId = r.intencao_id;
  state.registeredThisTurn = true;
  const valor = typeof r.valor === 'number' ? r.valor : produto.preco;
  return `Intenção registrada: ${produto.nome}, R$ ${valor.toFixed(2)}, pendente. ID: ${r.intencao_id}. Cartão ou pix?`;
}

function createAgent(
  usuario_id: string,
  pendingIntencaoId?: string,
): { agent: Agent; state: AgentState } {
  const state: AgentState = {
    lastPurchase: null,
    registeredIntencaoId: null,
    registeredThisTurn: false,
    verifiedPendingId:
      pendingIntencaoId && INTENCAO_ID_RE.test(pendingIntencaoId)
        ? pendingIntencaoId
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
      const r = (result ?? {}) as { ok?: unknown; intencao_id?: unknown };
      if (r.ok === true && typeof r.intencao_id === 'string') {
        state.registeredIntencaoId = r.intencao_id;
        state.registeredThisTurn = true;
      }
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
      if (!INTENCAO_ID_RE.test(intencao_id)) {
        const result = {
          ok: false,
          code: 'INTENCAO_INVALIDA',
          error:
            'intencao_id deve ser exatamente o ID retornado por registrar_intencao. Registre a intenção novamente.',
        };
        state.lastPurchase = normalizePurchase(result);
        return result;
      }

      let result: unknown;
      if (!TOOL_REALIZAR_COMPRA_ARN) {
        result = realizarCompraLocal(usuario_id, intencao_id, forma_pagamento);
      } else {
        result = await invokeLambda(TOOL_REALIZAR_COMPRA_ARN, {
          usuario_id,
          intencao_id,
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
2. Usuário escolhe produto → registrar_intencao agora. Use exatamente o intencao_id retornado. Mostre o ID e pergunte: cartão ou pix?
3. Usuário responde cartão/pix → realizar_compra com o intencao_id retornado por registrar_intencao.
4. Responda com o retorno:
   - ok: true → "Compra aprovada" + valor, forma e intencao_id.
   - ok: false → mostre o code e o próximo passo. Não esconda a falha.

## Regras
- Nunca invente id, preço ou status. Só mencione um intencao_id retornado por uma ferramenta nesta conversa; não copie IDs de exemplos.
- Se o usuário escolher um produto novo, ou se a intenção anterior estiver paga/cancelada/expirada, chame registrar_intencao de novo. Nunca reutilize o ID anterior.
- Só diga "registrada" se registrar_intencao retornou ok: true nesta mensagem.
- Só diga "aprovada", "confirmada" ou "paga" se realizar_compra retornou ok: true.
- Se uma ferramenta falhar, explique o code e diga o que o usuário pode fazer. Uma falha visível é melhor que inventar sucesso.
- Responda só à última mensagem. Nunca escreva "user:" ou "assistant:".
- Uma ferramenta por vez.
- Preço em R$ 0,00.
- O usuário autenticado é ${usuario_id}; não peça usuario_id.

## Exemplo
Usuário: Quero comprar o Fone Bluetooth.
Você: (chame registrar_intencao; use o ID retornado) Intenção registrada: Fone Bluetooth, R$ 199,90, pendente. Cartão ou pix?
Usuário: Pix.
Você: (chame realizar_compra com o ID retornado) Compra aprovada! Fone Bluetooth, R$ 199,90, pix.
`.trim(),
    }),
  };
}

// --- BedrockAgentCoreApp (local dev + AgentCore Runtime compatible) ---

interface AgentRequest {
  prompt?: unknown;
  usuario_id?: unknown;
  messages?: unknown;
  pending_intencao_id?: unknown;
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
        const conversation = toConversation(payload.messages);
        const { agent, state } = createAgent(
          usuario_id,
          typeof payload.pending_intencao_id === 'string'
            ? payload.pending_intencao_id
            : undefined,
        );
        const lastUserText = [...conversation]
          .reverse()
          .find((message) => message.role === 'user')
          ?.content.map((block) => block.text)
          .join(' ')
          .trim() || prompt.split('\n').filter((line) => /^user:/i.test(line)).pop()?.replace(/^user:\s*/i, '').trim() || '';
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
        let reply = sanitized;
        try {
          const fallback = await completeRegistrationFallback(
            usuario_id,
            state,
            lastUserText,
            sanitized,
          );
          if (fallback) {
            reply = fallback;
            console.log(
              JSON.stringify({
                guard: 'registration_fallback',
                intencao_id: state.registeredIntencaoId,
              }),
            );
          }
        } catch (err) {
          console.error('registration fallback error:', err);
        }

        const guardedRegistration = applyRegistrationGuard(reply, state);
        if (guardedRegistration !== reply) {
          console.log(JSON.stringify({ guard: 'registration_reply_adjusted' }));
        }
        reply = guardedRegistration;

        const guarded = applyPurchaseGuard(reply, state.lastPurchase);
        if (guarded !== reply) {
          console.log(
            JSON.stringify({
              guard: 'purchase_reply_adjusted',
              purchase: state.lastPurchase,
            }),
          );
        }
        reply = guarded;

        if (!state.lastPurchase) {
          try {
            const fallback = await completePaymentFallback(
              usuario_id,
              state,
              lastUserText,
            );
            if (fallback) {
              reply = fallback;
              console.log(
                JSON.stringify({
                  guard: 'payment_fallback_verified',
                  intencao_id: state.verifiedPendingId,
                  purchase: state.lastPurchase,
                }),
              );
            }
          } catch (err) {
            console.error('payment fallback error:', err);
          }
        }

        return JSON.stringify({
          ok: true,
          usuario_id,
          reply,
          purchase: state.lastPurchase,
          registered_intencao_id: state.registeredIntencaoId,
          registered: state.registeredThisTurn,
          pending_intencao_id: state.verifiedPendingId,
          intencao_id: state.registeredIntencaoId,
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
