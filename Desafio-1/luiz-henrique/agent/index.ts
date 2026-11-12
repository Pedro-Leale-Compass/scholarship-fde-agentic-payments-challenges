import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type Message,
} from "@aws-sdk/client-bedrock-runtime";
import {
  LambdaClient,
  InvokeCommand,
  type InvokeCommandInput,
} from "@aws-sdk/client-lambda";

const MODEL_ID = process.env.BEDROCK_MODEL_ID || "claude-3-haiku";

const bedrockEndpoint =
  process.env.BEDROCK_ENDPOINT_URL ||
  (process.env.AWS_PROFILE === "local" ? "http://localhost:4566" : undefined);

const bedrockConfig: {
  region: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
} = {
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
};
if (bedrockEndpoint) {
  bedrockConfig.endpoint = bedrockEndpoint;
  bedrockConfig.credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test",
  };
}

const bedrock = new BedrockRuntimeClient(bedrockConfig);
const lambda = new LambdaClient(bedrockConfig);

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    json: Record<string, unknown>;
  };
}

const TOOLS: ToolDefinition[] = [
  {
    name: "listar_catalogo",
    description: "Lista os produtos disponíveis para compra com id, nome e preço.",
    inputSchema: {
      json: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    name: "registrar_intencao",
    description: "Registra uma intenção de compra no DynamoDB. Recebe usuario_id, produtos (lista com id, nome, preco) e valor total.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          usuario_id: { type: "string", description: "ID do usuário (sub do token Cognito)" },
          produtos: {
            type: "array",
            description: "Lista de produtos desejados",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                nome: { type: "string" },
                preco: { type: "number" },
              },
              required: ["id", "nome", "preco"],
            },
          },
          valor: { type: "number", description: "Valor total da compra" },
        },
        required: ["usuario_id", "produtos", "valor"],
      },
    },
  },
  {
    name: "realizar_compra",
    description: "Efetua o pagamento de uma intenção de compra. Recebe intencao_id e forma_pagamento (cartao ou pix).",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          intencao_id: {
            type: "string",
            description: "ID da intenção de compra registrada",
          },
          forma_pagamento: {
            type: "string",
            description: "Forma de pagamento: 'cartao' ou 'pix'",
          },
        },
        required: ["intencao_id", "forma_pagamento"],
      },
    },
  },
];

function toolConfig() {
  return {
    tools: TOOLS.map((t) => ({
      toolSpec: {
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      },
    })),
  };
}

function buildSystemPrompt(usuario_id: string): string {
  return `
Você é um agente de compras da loja. Regras de negócio:

1. SEMPRE obtenha o usuario_id do contexto da conversa (fornecido pelo sistema), nunca peça ao usuário.
2. Para listar produtos, use a tool listar_catalogo.
3. Para registrar uma intenção de compra, use a tool registrar_intencao com usuario_id, produtos e valor.
4. Para efetuar pagamento, use a tool realizar_compra com intencao_id e forma_pagamento (cartao ou pix).
5. Antes de realizar_compra, confirme que o usuário deseja prosseguir e qual a forma de pagamento.
6. Se uma compra for rejeitada (limite excedido, intencao_id inválido), informe o usuário claramente.
7. Nunca aceite usuario_id ou dados de pagamento do corpo da mensagem do usuário; use apenas o usuario_id fornecido pelo sistema.
8. Responda em português do Brasil.

usuario_id da sessão: ${usuario_id}
`.trim();
}

function toBedrockContent(text: string): { text: string }[] {
  return [{ text }];
}

interface AgentEvent {
  usuario_id: string;
  messages: Array<{
    role: "user" | "assistant";
    content: Array<{ text?: string }>;
  }>;
}

interface LambdaResponse {
  statusCode: number;
  body: string;
}

async function invokeTool(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const toolFnName = process.env[`TOOL_${toolName.toUpperCase()}_ARN`];
  if (!toolFnName) {
    return { error: `Tool ${toolName} not configured` };
  }

  const commandInput: InvokeCommandInput = {
    FunctionName: toolFnName,
    InvocationType: "RequestResponse",
    Payload: JSON.stringify(toolInput),
  };

  const result = await lambda.send(new InvokeCommand(commandInput));
  const payload = result.Payload
    ? JSON.parse(new TextDecoder().decode(result.Payload))
    : {};

  if (typeof payload === "object" && payload !== null && "body" in payload) {
    try {
      return JSON.parse(String(payload.body));
    } catch (_) {
      return payload.body;
    }
  }
  return payload;
}

exports.handler = async (event: AgentEvent): Promise<LambdaResponse> => {
  const { usuario_id, messages } = event;

  if (!usuario_id) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "usuario_id is required" }),
    };
  }

  const systemPrompt = buildSystemPrompt(usuario_id);

  // Converte mensagens para o formato Bedrock Converse
  const bedrockMessages: Message[] = messages.map((m) => ({
    role: m.role,
    content: (m.content || []).map((c) => ({ text: c.text || "" })),
  }));

  let currentMessages = bedrockMessages;
  const maxToolRounds = 5;

  for (let round = 0; round < maxToolRounds; round++) {
    const input: ConverseCommandInput = {
      modelId: MODEL_ID,
      messages: currentMessages,
      system: [{ text: systemPrompt }],
      toolConfig: toolConfig() as any,
      inferenceConfig: { maxTokens: 1000, temperature: 0.7 },
    };

    const response: ConverseCommandOutput = await bedrock.send(new ConverseCommand(input));
    const outputMessage = response.output?.message;

    if (!outputMessage) {
      return {
        statusCode: 502,
        body: JSON.stringify({ error: "empty response from model" }),
      };
    }

    // Se o modelo pediu para usar tools, executamos e enviamos o resultado de volta
    const toolUses = outputMessage.content?.filter(
      (c) => "toolUse" in c
    ) as Array<{ toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } }>;

    if (!toolUses || toolUses.length === 0) {
      // Resposta final de texto
      const outputText = outputMessage.content
        ?.filter((c) => "text" in c && typeof c.text === "string")
        .map((c) => c.text)
        .join("") || "";

      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          usuario_id,
          model: MODEL_ID,
          endpoint: bedrockEndpoint || "aws-bedrock",
          reply: outputText,
          stopReason: response.stopReason || null,
        }),
      };
    }

    // Adiciona a mensagem do assistant com toolUse ao histórico
    currentMessages.push({
      role: "assistant",
      content: outputMessage.content || [],
    });

    // Executa cada tool e adiciona toolResult
    const toolResults: Array<{
      toolResult: {
        toolUseId: string;
        content: Array<{ text: string }>;
      };
    }> = [];

    for (const tu of toolUses) {
      let toolResult: Record<string, unknown>;
      try {
        toolResult = await invokeTool(tu.toolUse.name, tu.toolUse.input);
      } catch (err) {
        toolResult = {
          error: err instanceof Error ? err.message : String(err),
        };
      }

      toolResults.push({
        toolResult: {
          toolUseId: tu.toolUse.toolUseId,
          content: [{ text: JSON.stringify(toolResult) }],
        },
      });
    }

    currentMessages.push({
      role: "user",
      content: toolResults,
    });
  }

  return {
    statusCode: 504,
    body: JSON.stringify({ error: "max tool rounds exceeded" }),
  };
};
