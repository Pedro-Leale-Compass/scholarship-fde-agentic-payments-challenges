
import { randomUUID } from "node:crypto";
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  LambdaClient,
  InvokeCommand,
} from "@aws-sdk/client-lambda";

const db = DynamoDBDocumentClient.from(
  new DynamoDBClient({})
);

const lambda = new LambdaClient({});

const region = process.env.AWS_REGION || "us-east-1";

type MetodoPagamento = "PIX" | "CARTAO";

type ConfirmarPagamentoBody = {
  intencao_id?: unknown;
  metodo_pagamento?: unknown;
};

const intentionsTable = process.env.INTENTIONS_TABLE;
const realizarCompraArn = process.env.REALIZAR_COMPRA_ARN;

function resposta(
  statusCode: number,
  body: Record<string, unknown>
) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

async function buscarIntencao(intencaoId: string) {
  if (!intentionsTable) {
    throw new Error("INTENTIONS_TABLE não configurada");
  }

  const result = await db.send(
    new GetCommand({
      TableName: intentionsTable,
      Key: { id: intencaoId },
      ConsistentRead: true,
    })
  );

  return result.Item;
}

async function executarCompra(
  intencaoId: string,
  usuarioId: string,
  metodo: MetodoPagamento,
  autorizacaoId?: string
) {
  if (!realizarCompraArn) {
    throw new Error("REALIZAR_COMPRA_ARN não configurado");
  }

  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: realizarCompraArn,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(
        JSON.stringify({
          intencao_id: intencaoId,
          usuario_id: usuarioId,
          metodo_pagamento: metodo,
          autorizacao_id: autorizacaoId,
        })
      ),
    })
  );

  const raw = response.Payload
    ? Buffer.from(response.Payload).toString("utf-8")
    : "";

  if (response.FunctionError) {
    console.error("Erro na Lambda de compra:", raw);

    throw new Error("Falha ao executar a compra.");
  }

  if (!raw) {
    throw new Error("Resposta vazia da Lambda de compra.");
  }

  const resultado = JSON.parse(raw);

  if (!resultado.sucesso) {
    return {
      sucesso: false,
      erro: resultado.erro || "COMPRA_NAO_AUTORIZADA",
      mensagem: resultado.mensagem,
    };
  }

  return resultado;
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer =
  async (event) => {
    const usuarioId =
      event.requestContext.authorizer?.jwt?.claims?.sub;

    if (!usuarioId || typeof usuarioId !== "string") {
      return resposta(401, {
        sucesso: false,
        erro: "USUARIO_NAO_AUTENTICADO",
      });
    }

    if (!intentionsTable || !realizarCompraArn) {
      console.error("Variáveis de ambiente não configuradas");

      return resposta(500, {
        sucesso: false,
        erro: "CONFIGURACAO_INVALIDA",
      });
    }

    let body: ConfirmarPagamentoBody;

    try {
      body = JSON.parse(event.body || "{}");

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("Corpo inválido");
      }
    } catch {
      return resposta(400, {
        sucesso: false,
        erro: "JSON_INVALIDO",
      });
    }

    const { intencao_id, metodo_pagamento } = body;

    if (
      typeof intencao_id !== "string" ||
      !/^int_[0-9a-f-]{36}$/i.test(intencao_id)
    ) {
      return resposta(400, {
        sucesso: false,
        erro: "INTENCAO_INVALIDA",
      });
    }

    if (typeof metodo_pagamento !== "string") {
      return resposta(400, {
        sucesso: false,
        erro: "METODO_INVALIDO",
      });
    }

    const metodo = metodo_pagamento.toUpperCase();

    if (metodo !== "PIX" && metodo !== "CARTAO") {
      return resposta(400, {
        sucesso: false,
        erro: "METODO_INVALIDO",
      });
    }

    try {
      let intencao = await buscarIntencao(intencao_id);

      if (!intencao || intencao.usuario_id !== usuarioId) {
        return resposta(404, {
          sucesso: false,
          erro: "INTENCAO_INVALIDA",
        });
      }

      // Uma compra já paga pode retornar o resultado original.
      if (intencao.status === "PAGA") {
        const resultado = await executarCompra(
          intencao_id,
          usuarioId,
          metodo
        );

        return resposta(
          resultado.sucesso ? 200 : 409,
          resultado
        );
      }

      if (intencao.status !== "PENDENTE") {
        return resposta(409, {
          sucesso: false,
          erro: "INTENCAO_INVALIDA",
        });
      }

      if (
        typeof intencao.expira_em !== "string" ||
        !Number.isFinite(Date.parse(intencao.expira_em)) ||
        Date.now() >= Date.parse(intencao.expira_em) ||
        typeof intencao.ttl !== "number" ||
        intencao.ttl <= Math.floor(Date.now() / 1000)
      ) {
        return resposta(409, {
          sucesso: false,
          erro: "INTENCAO_EXPIRADA",
        });
      }

      if (
        !Number.isSafeInteger(intencao.valor_total_centavos) ||
        intencao.valor_total_centavos <= 0 ||
        !Number.isSafeInteger(intencao.quantidade) ||
        intencao.quantidade <= 0
      ) {
        return resposta(400, {
          sucesso: false,
          erro: "INTENCAO_INVALIDA",
        });
      }

      let autorizacaoId: string;

      // Se já existe autorização, somente permite continuar
      // quando ela pertence ao mesmo método de pagamento.
      if (intencao.autorizacao_id) {
        if (intencao.metodo_pagamento_autorizado !== metodo) {
          return resposta(409, {
            sucesso: false,
            erro: "AUTORIZACAO_JA_REGISTRADA",
            mensagem: "A intenção já possui autorização para outro método.",
          });
        }

        autorizacaoId = intencao.autorizacao_id;
      } else {
        autorizacaoId = `auth_${randomUUID()}`;

        try {
          await db.send(
            new UpdateCommand({
              TableName: intentionsTable,
              Key: { id: intencao_id },

              UpdateExpression:
                "SET autorizacao_id = :autorizacao, metodo_pagamento_autorizado = :metodo, autorizado_em = :agora",

              ConditionExpression:
                "#status = :pendente AND expira_em = :expiracao AND #ttl > :agoraEpoch AND attribute_not_exists(autorizacao_id)",

              ExpressionAttributeNames: {
                "#status": "status",
                "#ttl": "ttl",
              },

              ExpressionAttributeValues: {
                ":autorizacao": autorizacaoId,
                ":metodo": metodo,
                ":agora": new Date().toISOString(),
                ":pendente": "PENDENTE",
                ":expiracao": intencao.expira_em,
                ":agoraEpoch": Math.floor(Date.now() / 1000),
              },
            })
          );
        } catch (error) {
          // Outra requisição pode ter registrado a autorização.
          intencao = await buscarIntencao(intencao_id);

          if (
            !intencao ||
            intencao.usuario_id !== usuarioId ||
            intencao.status !== "PENDENTE" ||
            intencao.metodo_pagamento_autorizado !== metodo ||
            !intencao.autorizacao_id
          ) {
            console.error("Falha ao registrar autorização:", error);

            return resposta(409, {
              sucesso: false,
              erro: "AUTORIZACAO_NAO_REGISTRADA",
            });
          }

          autorizacaoId = intencao.autorizacao_id;
        }
      }

      // A confirmação é encaminhada à Lambda responsável
      // pela transação financeira.
      const resultado = await executarCompra(
        intencao_id,
        usuarioId,
        metodo as MetodoPagamento,
        autorizacaoId
      );

      return resposta(
        resultado.sucesso ? 200 : 409,
        resultado
      );

    } catch (error) {
      console.error("Erro ao confirmar pagamento:", error);

      return resposta(502, {
        sucesso: false,
        erro: "ERRO_AO_CONFIRMAR_PAGAMENTO",
        mensagem: "Não foi possível processar a confirmação.",
      });
    }
  };
