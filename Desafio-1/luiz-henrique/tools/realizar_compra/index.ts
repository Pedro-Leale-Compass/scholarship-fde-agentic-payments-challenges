import {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";

const INTENCOES_TABLE = process.env.INTENCOES_TABLE || "luiz-henrique-intencoes";
const USUARIOS_TABLE = process.env.USUARIOS_TABLE || "luiz-henrique-usuarios";

const client = new DynamoDBClient({
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
});

interface RealizarCompraEvent {
  body?: string;
  usuario_id?: string;
  intencao_id?: string;
  forma_pagamento?: "cartao" | "pix";
}

interface RealizarCompraBody {
  usuario_id?: string;
  intencao_id?: string;
  forma_pagamento?: "cartao" | "pix";
}

interface LambdaResponse {
  statusCode: number;
  body: string;
}

function readPayload(event: RealizarCompraEvent): RealizarCompraBody {
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

function fromDynamoString(item: Record<string, unknown>, key: string): string | undefined {
  const v = item[key];
  return typeof v === "object" && v !== null && "S" in v ? (v as { S: string }).S : undefined;
}

function fromDynamoNumber(item: Record<string, unknown>, key: string): number | undefined {
  const v = item[key];
  return typeof v === "object" && v !== null && "N" in v ? Number((v as { N: string }).N) : undefined;
}

function fail(
  statusCode: number,
  code: string,
  error: string,
  extra?: Record<string, unknown>,
): LambdaResponse {
  console.log(JSON.stringify({ tool: "realizar_compra", statusCode, code }));
  return {
    statusCode,
    body: JSON.stringify({ ok: false, code, error, ...extra }),
  };
}

/**
 * Marca a intenção como cancelada após uma falha de pagamento, para que ela não
 * continue pendente e não seja reutilizada.
 */
async function cancelIntencao(intencaoId: string, motivo: string): Promise<void> {
  try {
    await client.send(
      new UpdateItemCommand({
        TableName: INTENCOES_TABLE,
        Key: { intencao_id: dynamoString(intencaoId) },
        UpdateExpression:
          "SET #status = :cancelada, motivo_falha = :motivo, cancelada_em = :agora",
        ConditionExpression: "#status = :pendente",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":cancelada": dynamoString("cancelada"),
          ":motivo": dynamoString(motivo),
          ":agora": dynamoString(new Date().toISOString()),
          ":pendente": dynamoString("pendente"),
        },
      }),
    );
  } catch (err) {
    console.error("cancelIntencao error:", err);
  }
}

exports.handler = async (event: RealizarCompraEvent): Promise<LambdaResponse> => {
  const body = readPayload(event);
  const { usuario_id, intencao_id, forma_pagamento } = body;

  console.log(
    JSON.stringify({
      tool: "realizar_compra",
      usuario_id,
      intencao_id,
      forma_pagamento,
    }),
  );

  if (!intencao_id) {
    return fail(400, "INTENCAO_INVALIDA", "intencao_id is required");
  }
  if (!usuario_id) {
    return fail(400, "USUARIO_NAO_ENCONTRADO", "usuario_id is required");
  }
  if (!forma_pagamento || (forma_pagamento !== "cartao" && forma_pagamento !== "pix")) {
    return fail(400, "METODO_INVALIDO", "forma_pagamento must be 'cartao' or 'pix'");
  }

  try {
    const getResponse = await client.send(
      new GetItemCommand({
        TableName: INTENCOES_TABLE,
        Key: { intencao_id: dynamoString(intencao_id) },
      }),
    );
    const item = getResponse.Item;

    if (!item) {
      return fail(404, "INTENCAO_INVALIDA", "intencao_id invalido: intencao nao encontrada");
    }

    const dono = fromDynamoString(item, "usuario_id") || "";
    if (dono !== usuario_id) {
      // Não revela que a intenção existe para outro usuário.
      return fail(404, "INTENCAO_INVALIDA", "intencao_id invalido: intencao nao encontrada");
    }

    const status = fromDynamoString(item, "status") || "";
    if (status !== "pendente") {
      return fail(409, "INTENCAO_JA_PAGA", `intencao ja esta em status: ${status}`);
    }

    const expiraEm = fromDynamoString(item, "expira_em");
    if (expiraEm && new Date(expiraEm).getTime() <= Date.now()) {
      await cancelIntencao(intencao_id, "INTENCAO_EXPIRADA");
      return fail(
        410,
        "INTENCAO_EXPIRADA",
        "intencao expirada: registre uma nova intencao",
        { intencao_id, status: "cancelada" },
      );
    }

    const valor = fromDynamoNumber(item, "valor") || 0;
    const valorCentavos =
      fromDynamoNumber(item, "valor_centavos") ?? Math.round(valor * 100);

    const now = new Date().toISOString();

    const transaction: TransactWriteItemsCommandInput = {
      TransactItems: [
        {
          Update: {
            TableName: USUARIOS_TABLE,
            Key: { usuario_id: dynamoString(usuario_id) },
            UpdateExpression:
              "SET limite_centavos = limite_centavos - :valor, " +
              "gasto_total_centavos = if_not_exists(gasto_total_centavos, :zero) + :valor, " +
              "atualizado_em = :agora",
            ConditionExpression:
              "attribute_exists(usuario_id) AND limite_centavos >= :valor AND #status = :ativo",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":valor": dynamoNumber(valorCentavos),
              ":zero": dynamoNumber(0),
              ":agora": dynamoString(now),
              ":ativo": dynamoString("ativo"),
            },
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          },
        },
        {
          Update: {
            TableName: INTENCOES_TABLE,
            Key: { intencao_id: dynamoString(intencao_id) },
            UpdateExpression:
              "SET #status = :paga, forma_pagamento = :forma, pago_em = :agora",
            ConditionExpression: "#status = :pendente",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":paga": dynamoString("paga"),
              ":forma": dynamoString(forma_pagamento),
              ":agora": dynamoString(now),
              ":pendente": dynamoString("pendente"),
            },
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          },
        },
      ],
    };

    await client.send(new TransactWriteItemsCommand(transaction));

    console.log(
      JSON.stringify({
        tool: "realizar_compra",
        statusCode: 200,
        code: "COMPRA_APROVADA",
        intencao_id,
        valor_centavos: valorCentavos,
      }),
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        code: "COMPRA_APROVADA",
        intencao_id,
        usuario_id,
        valor,
        valor_centavos: valorCentavos,
        forma_pagamento,
        status: "paga",
        message: "Compra realizada com sucesso",
      }),
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const message = err instanceof Error ? err.message : String(err);

    if (name === "TransactionCanceledException") {
      const reasons = (
        err as { CancellationReasons?: Array<{ Code?: string; Item?: Record<string, unknown> }> }
      ).CancellationReasons;

      const intencaoReason = reasons?.[1];
      if (intencaoReason?.Code === "ConditionalCheckFailed") {
        return fail(409, "INTENCAO_JA_PAGA", "intencao nao esta disponivel para compra");
      }

      const usuarioReason = reasons?.[0];
      if (usuarioReason?.Code === "ConditionalCheckFailed") {
        if (!usuarioReason.Item) {
          return fail(
            404,
            "USUARIO_NAO_ENCONTRADO",
            "usuario sem cadastro na tabela Usuarios",
            { intencao_id },
          );
        }
        await cancelIntencao(intencao_id, "LIMITE_EXCEDIDO");
        return fail(
          422,
          "LIMITE_EXCEDIDO",
          "limite excedido: saldo disponivel insuficiente para esta compra",
          { intencao_id, status: "cancelada" },
        );
      }
    }

    if (name === "ConditionalCheckFailedException") {
      return fail(409, "INTENCAO_JA_PAGA", "intencao nao esta disponivel para compra");
    }

    console.error("realizar_compra error:", err);
    return fail(500, "ERRO_INTERNO", "nao foi possivel concluir a compra");
  }
};
