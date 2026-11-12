import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
  type GetItemCommandInput,
  type UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";

const INTENCOES_TABLE = process.env.INTENCOES_TABLE || "luiz-henrique-intencoes";

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

interface RealizarCompraBody {
  intencao_id?: string;
  forma_pagamento?: "cartao" | "pix";
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

function fromDynamoString(item: Record<string, unknown>, key: string): string | undefined {
  const v = item[key];
  return typeof v === "object" && v !== null && "S" in v ? (v as { S: string }).S : undefined;
}

function fromDynamoNumber(item: Record<string, unknown>, key: string): number | undefined {
  const v = item[key];
  return typeof v === "object" && v !== null && "N" in v ? Number((v as { N: string }).N) : undefined;
}

exports.handler = async (event: {
  body?: string;
  headers?: Record<string, string>;
}): Promise<LambdaResponse> => {
  let body: RealizarCompraBody = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    body = {};
  }

  const { intencao_id, forma_pagamento } = body;

  if (!intencao_id) {
    return {
      statusCode: 400,
      body: JSON.stringify({ ok: false, error: "intencao_id is required" }),
    };
  }
  if (!forma_pagamento || (forma_pagamento !== "cartao" && forma_pagamento !== "pix")) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        ok: false,
        error: "forma_pagamento must be 'cartao' or 'pix'",
      }),
    };
  }

  const getInput: GetItemCommandInput = {
    TableName: INTENCOES_TABLE,
    Key: {
      intencao_id: dynamoString(intencao_id),
    },
  };

  try {
    const getResponse = await client.send(new GetItemCommand(getInput));
    const item = getResponse.Item;

    if (!item) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          ok: false,
          error: "intencao_id invalido: intencao nao encontrada",
        }),
      };
    }

    const status = fromDynamoString(item, "status") || "";
    if (status !== "pendente") {
      return {
        statusCode: 409,
        body: JSON.stringify({
          ok: false,
          error: `intencao ja esta em status: ${status}`,
        }),
      };
    }

    const valor = fromDynamoNumber(item, "valor") || 0;
    const usuario_id = fromDynamoString(item, "usuario_id") || "";

    const updateInput: UpdateItemCommandInput = {
      TableName: INTENCOES_TABLE,
      Key: {
        intencao_id: dynamoString(intencao_id),
      },
      UpdateExpression:
        "SET #status = :status, forma_pagamento = :forma_pagamento, pago_em = :pago_em",
      ConditionExpression: "#status = :pendente",
      ExpressionAttributeNames: {
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":status": dynamoString("paga"),
        ":forma_pagamento": dynamoString(forma_pagamento),
        ":pago_em": dynamoString(new Date().toISOString()),
        ":pendente": dynamoString("pendente"),
      },
      ReturnValues: "ALL_NEW",
    };

    await client.send(new UpdateItemCommand(updateInput));

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        intencao_id,
        usuario_id,
        valor,
        forma_pagamento,
        status: "paga",
        message: "Compra realizada com sucesso",
      }),
    };
  } catch (err) {
    console.error("realizar_compra error:", err);
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes("ConditionalCheckFailed")) {
      return {
        statusCode: 409,
        body: JSON.stringify({
          ok: false,
          error: "intencao nao esta disponivel para compra (ja processada ou invalida)",
        }),
      };
    }

    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: message }),
    };
  }
};
