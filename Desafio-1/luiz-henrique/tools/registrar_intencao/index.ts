import {
  DynamoDBClient,
  PutItemCommand,
  type PutItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import { v4 as uuidv4 } from "uuid";

const INTENCOES_TABLE = process.env.INTENCOES_TABLE || "luiz-henrique-intencoes";

const client = new DynamoDBClient({
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
});

interface RegistrarIntencaoEvent {
  body?: string;
  usuario_id?: string;
  produtos?: Array<{ id: string; nome: string; preco: number }>;
  valor?: number;
}

/**
 * A Lambda é invocada pelo agente (payload direto) e, em testes, pelo API Gateway
 * (payload dentro de `body`). Aceita os dois formatos.
 */
function readPayload(event: RegistrarIntencaoEvent): RegistrarIntencaoBody {
  if (typeof event.body === "string") {
    try {
      return JSON.parse(event.body || "{}");
    } catch (_) {
      return {};
    }
  }
  return event;
}

interface RegistrarIntencaoBody {
  usuario_id?: string;
  produtos?: Array<{ id: string; nome: string; preco: number }>;
  valor?: number;
}

interface LambdaResponse {
  statusCode: number;
  body: string;
}

function dynamoString(value: string): { S: string } {
  return { S: value };
}

function dynamoNumber(value: number): { N: string } {
  return { N: String(value) };
}

function dynamoList(
  items: Array<{ id: string; nome: string; preco: number }>
): { L: { M: Record<string, { S: string } | { N: string }> }[] } {
  return {
    L: items.map((p) => ({
      M: {
        id: dynamoString(p.id),
        nome: dynamoString(p.nome),
        preco: dynamoNumber(p.preco),
      },
    })),
  };
}

exports.handler = async (event: RegistrarIntencaoEvent): Promise<LambdaResponse> => {
  const body = readPayload(event);

  const { usuario_id, produtos, valor } = body;

  if (!usuario_id) {
    return {
      statusCode: 400,
      body: JSON.stringify({ ok: false, error: "usuario_id is required" }),
    };
  }
  if (!produtos || !Array.isArray(produtos) || produtos.length === 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({ ok: false, error: "produtos is required and must be non-empty" }),
    };
  }
  if (typeof valor !== "number" || valor <= 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({ ok: false, error: "valor must be a positive number" }),
    };
  }

  const intencao_id = uuidv4();

  const input: PutItemCommandInput = {
    TableName: INTENCOES_TABLE,
    Item: {
      intencao_id: dynamoString(intencao_id),
      usuario_id: dynamoString(usuario_id),
      produtos: dynamoList(produtos),
      valor: dynamoNumber(valor),
      status: dynamoString("pendente"),
      created_at: dynamoString(new Date().toISOString()),
    },
    ConditionExpression: "attribute_not_exists(intencao_id)",
  };

  try {
    await client.send(new PutItemCommand(input));

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        intencao_id,
        usuario_id,
        produtos,
        valor,
        status: "pendente",
        message: "Intencao registrada com sucesso",
      }),
    };
  } catch (err) {
    console.error("registrar_intencao error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};
