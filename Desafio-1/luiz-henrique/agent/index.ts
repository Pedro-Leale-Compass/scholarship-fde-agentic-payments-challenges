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

function createAgent(usuario_id: string): Agent {
  const listarCatalogoTool = new ZodTool({
    name: 'listar_catalogo',
    description: 'Lista os produtos disponíveis para compra com id, nome e preço.',
    inputSchema: z.object({}),
    callback: async () => {
      if (!TOOL_LISTAR_CATALOGO_ARN) return listarCatalogoLocal();
      return invokeLambda(TOOL_LISTAR_CATALOGO_ARN, {});
    },
  });

  const registrarIntencaoTool = new ZodTool({
    name: 'registrar_intencao',
    description: 'Registra uma intenção de compra para o usuário autenticado.',
    inputSchema: z.object({
      produtos: z.array(
        z.object({ id: z.string(), nome: z.string(), preco: z.number() })
      ).describe('Lista de produtos desejados'),
      valor: z.number().describe('Valor total da compra'),
    }),
    callback: async ({ produtos, valor }) => {
      if (!TOOL_REGISTRAR_INTENCAO_ARN) {
        return registrarIntencaoLocal(usuario_id, produtos, valor);
      }
      return invokeLambda(TOOL_REGISTRAR_INTENCAO_ARN, { usuario_id, produtos, valor });
    },
  });

  const realizarCompraTool = new ZodTool({
    name: 'realizar_compra',
    description: 'Efetua pagamento de uma intenção de compra.',
    inputSchema: z.object({
      intencao_id: z.string().describe('ID da intenção de compra'),
      forma_pagamento: z.enum(['cartao', 'pix']).describe('Forma de pagamento: cartao ou pix'),
    }),
    callback: async ({ intencao_id, forma_pagamento }) => {
      if (!TOOL_REALIZAR_COMPRA_ARN) {
        return realizarCompraLocal(usuario_id, intencao_id, forma_pagamento);
      }
      return invokeLambda(TOOL_REALIZAR_COMPRA_ARN, { intencao_id, forma_pagamento });
    },
  });

  return new Agent({
    model: new BedrockModel({ modelId: MODEL_ID, region: REGION }),
    tools: [listarCatalogoTool, registrarIntencaoTool, realizarCompraTool],
    systemPrompt: `
Você é um agente de compras da loja. Regras de negócio:

1. O usuário autenticado é ${usuario_id}. Nunca peça nem aceite usuario_id do usuário; ele é fornecido pelo sistema.
2. Para listar produtos, use a tool listar_catalogo.
3. Para registrar uma intenção de compra, use a tool registrar_intencao com produtos e valor.
4. Para efetuar pagamento, use a tool realizar_compra com intencao_id e forma_pagamento (cartao ou pix).
5. Antes de realizar_compra, confirme que o usuário deseja prosseguir e qual a forma de pagamento.
6. Se uma compra for rejeitada (limite excedido, intencao_id inválido), informe o usuário claramente.
7. Nunca aceite dados de pagamento do corpo da mensagem do usuário.
8. Responda em português do Brasil e seja direto.
`.trim(),
  });
}

// --- BedrockAgentCoreApp (local dev + AgentCore Runtime compatible) ---

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema: z.object({
      prompt: z.string().describe('Mensagem do usuário'),
      usuario_id: z.string().describe('ID do usuário (sub do token Cognito)'),
    }),
    process: async (request) => {
      const { prompt, usuario_id } = request as { prompt: string; usuario_id: string };

      try {
        const agent = createAgent(usuario_id);
        const chunks: string[] = [];
        for await (const event of agent.stream(prompt)) {
          if (event.type === 'contentBlockEvent') {
            const block = event.contentBlock;
            if ((block as { type?: string }).type === 'textBlock') {
              chunks.push((block as { text?: string }).text || '');
            }
          }
        }

        return {
          ok: true,
          usuario_id,
          reply: chunks.join('').trim() || 'Não foi possível gerar uma resposta.',
          model: MODEL_ID,
        };
      } catch (err) {
        console.error('agent invocation error:', err);
        throw err;
      }
    },
  },
});

app.run({ port: Number(process.env.PORT) || 3031 });

export { app, createAgent };
