import {
  DynamoDBClient,
  ScanCommand,
  type ScanCommandOutput,
} from "@aws-sdk/client-dynamodb";

const CATALOGO_TABLE = process.env.CATALOGO_TABLE || "luiz-henrique-catalogo";

const endpoint =
  process.env.AWS_ENDPOINT_URL ||
  process.env.BEDROCK_ENDPOINT_URL ||
  (process.env.AWS_PROFILE === "local" ? "http://localhost:4566" : undefined);

const clientConfig: {
  region: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
} = {
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
};
if (endpoint) {
  clientConfig.endpoint = endpoint;
  clientConfig.credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test",
  };
}

const client = new DynamoDBClient(clientConfig);

interface CatalogoItem {
  id: string;
  nome: string;
  preco: number;
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
  return {
    id: getS("id") || "",
    nome: getS("nome") || "",
    preco: getN("preco") || 0,
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
