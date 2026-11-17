import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  type PutItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import { randomBytes } from "crypto";

const INTENCOES_TABLE = process.env.INTENCOES_TABLE || "luiz-henrique-intencoes";
const CATALOGO_TABLE = process.env.CATALOGO_TABLE || "luiz-henrique-catalogo";

/**
 * IDs curtos e legíveis (INT-1A2B3C4D) em vez de UUID. O modelo copia IDs curtos
 * com muito menos alucinação; o formato antigo (UUID) continua válido na tool.
 */
function gerarIntencaoId(): string {
  return `INT-${randomBytes(4).toString("hex").toUpperCase()}`;
}

const client = new DynamoDBClient({
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
});

interface ItemInput {
  produto_id?: string;
  quantidade?: number;
}

interface RegistrarIntencaoBody {
  usuario_id?: string;
  itens?: ItemInput[];
}

interface RegistrarIntencaoEvent extends RegistrarIntencaoBody {
  body?: string;
}

interface CatalogoItem {
  id: string;
  nome: string;
  preco: number;
  preco_centavos: number;
}

interface ProdutoSnapshot extends CatalogoItem {
  quantidade: number;
}

interface LambdaResponse {
  statusCode: number;
  body: string;
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

function dynamoString(value: string): { S: string } {
  return { S: value };
}

function dynamoNumber(value: number): { N: string } {
  return { N: String(value) };
}

function dynamoList(
  items: ProdutoSnapshot[],
): { L: { M: Record<string, { S: string } | { N: string }> }[] } {
  return {
    L: items.map((p) => ({
      M: {
        id: dynamoString(p.id),
        nome: dynamoString(p.nome),
        preco: dynamoNumber(p.preco),
        preco_centavos: dynamoNumber(p.preco_centavos),
        quantidade: dynamoNumber(p.quantidade),
      },
    })),
  };
}

function fail(statusCode: number, code: string, error: string): LambdaResponse {
  return { statusCode, body: JSON.stringify({ ok: false, code, error }) };
}

async function getCatalogoItem(produtoId: string): Promise<CatalogoItem | null> {
  const response = await client.send(
    new GetItemCommand({
      TableName: CATALOGO_TABLE,
      Key: { id: { S: produtoId } },
    }),
  );
  const item = response.Item;
  if (!item) return null;

  const nome = item.nome?.S || "";
  const precoCentavos = Number(
    item.preco_centavos?.N ??
      Math.round(Number(item.preco?.N || 0) * 100),
  );
  if (!nome || !Number.isFinite(precoCentavos) || precoCentavos <= 0) {
    return null;
  }

  return {
    id: produtoId,
    nome,
    preco: precoCentavos / 100,
    preco_centavos: precoCentavos,
  };
}

exports.handler = async (
  event: RegistrarIntencaoEvent,
): Promise<LambdaResponse> => {
  const body = readPayload(event);
  const usuario_id = body.usuario_id;
  const itens = Array.isArray(body.itens) ? body.itens : [];

  if (!usuario_id) {
    return fail(400, "USUARIO_NAO_ENCONTRADO", "usuario_id is required");
  }
  if (itens.length === 0) {
    return fail(400, "PRODUTO_INVALIDO", "itens is required and must be non-empty");
  }

  // Agrega quantidades por produto e valida antes de consultar o catálogo.
  const quantities = new Map<string, number>();
  for (const item of itens) {
    const produtoId = item?.produto_id;
    const quantidade = item?.quantidade ?? 1;
    if (!produtoId || typeof produtoId !== "string") {
      return fail(400, "PRODUTO_INVALIDO", "cada item precisa de produto_id");
    }
    if (!Number.isInteger(quantidade) || quantidade <= 0) {
      return fail(400, "QUANTIDADE_INVALIDA", "quantidade deve ser inteiro positivo");
    }
    quantities.set(produtoId, (quantities.get(produtoId) || 0) + quantidade);
  }

  const produtos: ProdutoSnapshot[] = [];
  let valorCentavos = 0;
  for (const [produtoId, quantidade] of quantities) {
    const produto = await getCatalogoItem(produtoId);
    if (!produto) {
      return fail(400, "PRODUTO_INVALIDO", `produto_id nao encontrado: ${produtoId}`);
    }
    produtos.push({ ...produto, quantidade });
    valorCentavos += produto.preco_centavos * quantidade;
  }

  if (valorCentavos <= 0) {
    return fail(400, "PRODUTO_INVALIDO", "valor total invalido");
  }

  const intencao_id = gerarIntencaoId();
  const valor = valorCentavos / 100;
  const expira_em = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  console.log(
    JSON.stringify({
      tool: "registrar_intencao",
      usuario_id,
      intencao_id,
      valor,
      valor_centavos: valorCentavos,
      itens: produtos.map((p) => ({
        produto_id: p.id,
        quantidade: p.quantidade,
        preco_centavos: p.preco_centavos,
      })),
    }),
  );

  const input: PutItemCommandInput = {
    TableName: INTENCOES_TABLE,
    Item: {
      intencao_id: dynamoString(intencao_id),
      usuario_id: dynamoString(usuario_id),
      produtos: dynamoList(produtos),
      valor: dynamoNumber(valor),
      valor_centavos: dynamoNumber(valorCentavos),
      status: dynamoString("pendente"),
      created_at: dynamoString(now),
      expira_em: dynamoString(expira_em),
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
        valor_centavos: valorCentavos,
        status: "pendente",
        expira_em,
        message: "Intencao registrada com sucesso",
      }),
    };
  } catch (err) {
    console.error("registrar_intencao error:", err);
    return fail(
      500,
      "ERRO_INTERNO",
      err instanceof Error ? err.message : String(err),
    );
  }
};
