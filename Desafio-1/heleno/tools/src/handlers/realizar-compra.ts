
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";

const db = DynamoDBDocumentClient.from(
  new DynamoDBClient({})
);

type RealizarCompraEvent = {
  intencao_id?: string;
  usuario_id?: string;
  metodo_pagamento?: string;
  autorizacao_id?: string;
};

type MetodoPagamento = "PIX" | "CARTAO";

export const handler = async (
  event: RealizarCompraEvent = {}
) => {
  const catalogTable = process.env.CATALOG_TABLE;
  const usersTable = process.env.USERS_TABLE;
  const intentionsTable = process.env.INTENTIONS_TABLE;
  const transactionsTable = process.env.TRANSACTIONS_TABLE;

  if (
    !catalogTable ||
    !usersTable ||
    !intentionsTable ||
    !transactionsTable
  ) {
    throw new Error("Variáveis de ambiente não configuradas");
  }

  const {
    intencao_id,
    usuario_id,
    metodo_pagamento,
    autorizacao_id,
  } = event;

  if (!intencao_id || !usuario_id) {
    return {
      sucesso: false,
      erro: "DADOS_INVALIDOS",
    };
  }

  const metodo = metodo_pagamento?.toUpperCase();

  if (metodo !== "PIX" && metodo !== "CARTAO") {
    return {
      sucesso: false,
      erro: "METODO_INVALIDO",
    };
  }

  const buscarIntencao = async () => {
    const response = await db.send(
      new GetCommand({
        TableName: intentionsTable,
        Key: { id: intencao_id },
        ConsistentRead: true,
      })
    );

    return response.Item;
  };

  // Recupera e verifica a transação original.
  const resultadoCompraExistente = async (intencao: any) => {
    if (intencao.usuario_id !== usuario_id) {
      return {
        sucesso: false,
        erro: "INTENCAO_INVALIDA",
      };
    }

    if (intencao.metodo_pagamento !== metodo) {
      return {
        sucesso: false,
        erro: "INTENCAO_JA_PAGA",
        mensagem: "A intenção já foi paga com outro método.",
      };
    }

    if (!intencao.transacao_id) {
      return {
        sucesso: false,
        erro: "TRANSACAO_NAO_ENCONTRADA",
      };
    }

    const response = await db.send(
      new GetCommand({
        TableName: transactionsTable,
        Key: { id: intencao.transacao_id },
        ConsistentRead: true,
      })
    );

    const transacao = response.Item;

    if (
      !transacao ||
      transacao.intencao_id !== intencao_id ||
      transacao.usuario_id !== usuario_id ||
      transacao.status !== "APROVADA" ||
      transacao.metodo_pagamento !== metodo
    ) {
      return {
        sucesso: false,
        erro: "TRANSACAO_NAO_ENCONTRADA",
      };
    }

    return {
      sucesso: true,
      transacao_id: transacao.id,
      intencao_id,
      status: "APROVADA",
      metodo_pagamento: metodo as MetodoPagamento,
      valor_total: transacao.valor_total_centavos / 100,
      idempotente: true,
    };
  };

  const intencao = await buscarIntencao();

  if (!intencao || intencao.usuario_id !== usuario_id) {
    return {
      sucesso: false,
      erro: "INTENCAO_INVALIDA",
    };
  }

  // Preserva a idempotência das compras já concluídas.
  if (intencao.status === "PAGA") {
    return resultadoCompraExistente(intencao);
  }

  if (intencao.status !== "PENDENTE") {
    return {
      sucesso: false,
      erro: "INTENCAO_INVALIDA",
    };
  }

  // Uma compra pendente exige autorização emitida
  // pela ConfirmarPagamentoFunction.
  if (
    !autorizacao_id ||
    intencao.autorizacao_id !== autorizacao_id ||
    intencao.metodo_pagamento_autorizado !== metodo
  ) {
    return {
      sucesso: false,
      erro: "PAGAMENTO_NAO_AUTORIZADO",
      mensagem: "A confirmação do pagamento não foi validada.",
    };
  }

  if (
    typeof intencao.expira_em !== "string" ||
    !Number.isFinite(Date.parse(intencao.expira_em))
  ) {
    return {
      sucesso: false,
      erro: "INTENCAO_INVALIDA",
    };
  }

  if (
    Date.now() >= Date.parse(intencao.expira_em) ||
    typeof intencao.ttl !== "number" ||
    Math.floor(Date.now() / 1000) >= intencao.ttl
  ) {
    return {
      sucesso: false,
      erro: "INTENCAO_EXPIRADA",
    };
  }

  const valor = intencao.valor_total_centavos;
  const quantidade = intencao.quantidade;

  if (
    !Number.isSafeInteger(valor) ||
    valor <= 0 ||
    !Number.isSafeInteger(quantidade) ||
    quantidade <= 0 ||
    typeof intencao.produto_id !== "string"
  ) {
    return {
      sucesso: false,
      erro: "INTENCAO_INVALIDA",
    };
  }

  const transacaoId = `txn_${randomUUID()}`;
  const agora = new Date().toISOString();
  const agoraEpoch = Math.floor(Date.now() / 1000);

  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          // 1. Desconta o estoque.
          {
            Update: {
              TableName: catalogTable,
              Key: { id: intencao.produto_id },
              UpdateExpression:
                "SET estoque = estoque - :quantidade",
              ConditionExpression:
                "attribute_exists(id) AND estoque >= :quantidade",
              ExpressionAttributeValues: {
                ":quantidade": quantidade,
              },
            },
          },

          // 2. Desconta o limite financeiro.
          {
            Update: {
              TableName: usersTable,
              Key: { id: usuario_id },
              UpdateExpression:
                "SET limite_centavos = limite_centavos - :valor",
              ConditionExpression:
                "attribute_exists(id) AND limite_centavos >= :valor",
              ExpressionAttributeValues: {
                ":valor": valor,
              },
            },
          },

          // 3. Marca a intenção como paga e consome
          // a autorização na mesma transação.
          {
            Update: {
              TableName: intentionsTable,
              Key: { id: intencao_id },

              UpdateExpression:
                "SET #status = :paga, transacao_id = :transacao, metodo_pagamento = :metodo REMOVE autorizacao_id, metodo_pagamento_autorizado, autorizado_em",

              ConditionExpression:
                "#status = :pendente AND expira_em = :expiracao AND #ttl > :agora AND autorizacao_id = :autorizacao AND metodo_pagamento_autorizado = :metodo",

              ExpressionAttributeNames: {
                "#status": "status",
                "#ttl": "ttl",
              },

              ExpressionAttributeValues: {
                ":paga": "PAGA",
                ":pendente": "PENDENTE",
                ":transacao": transacaoId,
                ":metodo": metodo,
                ":expiracao": intencao.expira_em,
                ":agora": agoraEpoch,
                ":autorizacao": autorizacao_id,
              },
            },
          },

          // 4. Registra a transação.
          {
            Put: {
              TableName: transactionsTable,
              Item: {
                id: transacaoId,
                intencao_id,
                usuario_id,
                produto_id: intencao.produto_id,
                quantidade,
                valor_total_centavos: valor,
                metodo_pagamento: metodo,
                status: "APROVADA",
                criado_em: agora,
              },
              ConditionExpression:
                "attribute_not_exists(id)",
            },
          },
        ],
      })
    );

    return {
      sucesso: true,
      transacao_id: transacaoId,
      intencao_id,
      status: "APROVADA",
      metodo_pagamento: metodo,
      valor_total: valor / 100,
      idempotente: false,
    };

  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "TransactionCanceledException"
    ) {
      const intencaoAtualizada = await buscarIntencao();

      if (
        intencaoAtualizada &&
        intencaoAtualizada.usuario_id === usuario_id &&
        intencaoAtualizada.status === "PAGA"
      ) {
        return resultadoCompraExistente(intencaoAtualizada);
      }

      return {
        sucesso: false,
        erro: "COMPRA_NAO_AUTORIZADA",
        mensagem:
          "Estoque, limite, autorização ou status da intenção não permitem a compra.",
      };
    }

    console.error("Erro ao realizar compra:", error);
    throw error;
  }
};
