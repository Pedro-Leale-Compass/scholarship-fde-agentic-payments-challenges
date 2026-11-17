import {
  DynamoDBClient,
  ScanCommand,
  type ScanCommandOutput,
} from "@aws-sdk/client-dynamodb";

const CATALOGO_TABLE = process.env.CATALOGO_TABLE || "luiz-henrique-catalogo";

const client = new DynamoDBClient({
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
});

interface CatalogoItem {
  id: string;
  nome: string;
  preco: number;
  preco_centavos: number;
}

function toCatalogoItem(item: Record<string, unknown>): CatalogoItem {
  const getS = (key: string): string | undefined => {
    const v = item[key];
    return typeof v === "object" && v !== null && "S" in v
      ? (v as { S: string }).S
      : undefined;
  };
  const getN = (key: string): number | undefined => {
    const v = item[key];
    return typeof v === "object" && v !== null && "N" in v
      ? Number((v as { N: string }).N)
      : undefined;
  };
  const precoCentavos = getN("preco_centavos");
  const preco = precoCentavos !== undefined ? precoCentavos / 100 : getN("preco") || 0;
  return {
    id: getS("id") || "",
    nome: getS("nome") || "",
    preco,
    preco_centavos:
      precoCentavos !== undefined ? precoCentavos : Math.round(preco * 100),
  };
}

interface LambdaResponse {
  statusCode: number;
  body: string;
}

exports.handler = async (): Promise<LambdaResponse> => {
  try {
    const command = new ScanCommand({
      TableName: CATALOGO_TABLE,
    });

    const response: ScanCommandOutput = await client.send(command);

    const items: CatalogoItem[] = (response.Items || []).map(toCatalogoItem);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        catalogo: items,
        count: items.length,
      }),
    };
  } catch (err) {
    console.error("listar_catalogo error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};
