/**
 * Agente Strands no AgentCore Runtime — Desafio 1 (luiz-henrique).
 *
 * Usa bedrock-agentcore SDK (BedrockAgentCoreApp) + @strands-agents/sdk.
 * Mesmo código roda local e na AWS:
 *   - Local:  `npm run dev` → BedrockAgentCoreApp roda localmente (sem AWS)
 *   - Remoto: container no AgentCore Runtime via CDK (CfnAgentRuntime)
 *
 * As 3 tools invocam as respectivas Lambdas DynamoDB. Em modo local sem AWS,
 * usam funções stub.
 */

import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { Agent, BedrockModel, ZodTool, tool } from '@strands-agents/sdk';
import { z } from 'zod';
import {
  LambdaClient,
  InvokeCommand,
  type InvokeCommandInput,
} from '@aws-sdk/client-lambda';

const MODEL_ID = process.env.BEDROCK_MODEL_ID || 'global.amazon.nova-2-lite-v1:0';
const IS_LOCAL = process.env.AWS_PROFILE === 'local' || process.env.LOCAL_DEV === 'true';

const lambdaConfig: {
  region: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
} = {
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
};
const endpoint = process.env.BEDROCK_ENDPOINT_URL || (IS_LOCAL ? 'http://localhost:4566' : undefined);
if (endpoint) {
  lambdaConfig.endpoint = endpoint;
  lambdaConfig.credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
  };
}
const lambdaClient = new LambdaClient(lambdaConfig);

const TOOL_LISTAR_CATALOGO_ARN = process.env.TOOL_LISTAR_CATALOGO_ARN;
const TOOL_REGISTRAR_INTENCAO_ARN = process.env.TOOL_REGISTRAR_INTENCAO_ARN;
const TOOL_REALIZAR_COMPRA_ARN = process.env.TOOL_REALIZAR_COMPRA_ARN;

async function invokeLambda(functionArn: string | undefined, payload: Record<string, unknown>): Promise<unknown> {
  if (!functionArn || IS_LOCAL) {
    return { ok: true, local: true, function: functionArn || 'local-stub', input: payload };
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

// --- Tool definitions using ZodTool ---

const listarCatalogoTool = new ZodTool({
  name: 'listar_catalogo',
  description: 'Lista os produtos disponíveis para compra com id, nome e preço.',
  inputSchema: z.object({}),
  callback: async () => {
    return invokeLambda(TOOL_LISTAR_CATALOGO_ARN, {});
  },
});

const registrarIntencaoTool = new ZodTool({
  name: 'registrar_intencao',
  description: 'Registra uma intenção de compra no DynamoDB.',
  inputSchema: z.object({
    usuario_id: z.string().describe('ID do usuário (sub do token Cognito)'),
    produtos: z.array(
      z.object({ id: z.string(), nome: z.string(), preco: z.number() })
    ).describe('Lista de produtos desejados'),
    valor: z.number().describe('Valor total da compra'),
  }),
  callback: async ({ usuario_id, produtos, valor }) => {
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
    return invokeLambda(TOOL_REALIZAR_COMPRA_ARN, { intencao_id, forma_pagamento });
  },
});

const tools = [listarCatalogoTool, registrarIntencaoTool, realizarCompraTool];

// --- Strands Agent ---

const agent = new Agent({
  model: MODEL_ID as string,
  tools,
  systemPrompt: `
Você é um agente de compras da loja. Regras de negócio:

1. SEMPRE obtenha o usuario_id do contexto da conversa (fornecido pelo sistema), nunca peça ao usuário.
2. Para listar produtos, use a tool listar_catalogo.
3. Para registrar uma intenção de compra, use a tool registrar_intencao com usuario_id, produtos e valor.
4. Para efetuar pagamento, use a tool realizar_compra com intencao_id e forma_pagamento (cartao ou pix).
5. Antes de realizar_compra, confirme que o usuário deseja prosseguir e qual a forma de pagamento.
6. Se uma compra for rejeitada (limite excedido, intencao_id inválido), informe o usuário claramente.
7. Nunca aceite usuario_id ou dados de pagamento do corpo da mensagem do usuário; use apenas o usuario_id fornecido pelo sistema.
8. Responda em português do Brasil.
`.trim(),
});

// --- BedrockAgentCoreApp (local dev + AgentCore Runtime compatible) ---

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema: z.object({
      prompt: z.string().describe('Mensagem do usuário'),
      usuario_id: z.string().describe('ID do usuário (sub do token Cognito)'),
    }),
    process: async (request) => {
      const { prompt, usuario_id } = request as { prompt: string; usuario_id: string };
      const chunks: string[] = [];
      for await (const event of agent.stream(prompt)) {
        if (event.type === 'contentBlockEvent') {
          const block = event.contentBlock;
          if ((block as { type?: string }).type === 'textBlock') {
            chunks.push((block as { text?: string }).text || '');
          }
        }
      }
      return { ok: true, usuario_id, reply: chunks.join('') };
    },
  },
});

if (IS_LOCAL || process.env.NODE_ENV === 'development') {
  app.run({ port: Number(process.env.PORT) || 3000 });
}

export { app, agent };
