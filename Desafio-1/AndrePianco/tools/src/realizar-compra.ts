import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { METODOS_PAGAMENTO } from "@desafio/shared";
import type {
  CompraRecusada,
  ErroCompra,
  Intencao,
  MetodoPagamento,
  RealizarCompraArgs,
  ResultadoCompra,
} from "@desafio/shared";
import { db, tabelas } from "./lib/db.js";
import {
  ArgumentoInvalido,
  auditar,
  centavos,
  comTratamento,
  exigirUsuario,
  idAleatorio,
  type EventoTool,
} from "./lib/comum.js";

function recusar(erro: ErroCompra, mensagem: string): CompraRecusada {
  return { status: "recusado", erro, mensagem };
}

async function lerIntencao(id: string): Promise<Intencao | undefined> {
  const { Item } = await db.send(
    new GetCommand({ TableName: tabelas.intencoes(), Key: { intencao_id: id }, ConsistentRead: true }),
  );
  return Item as Intencao | undefined;
}

/** Limite ainda disponivel. Usuario sem cadastro nao tem credito (Fase 1). */
async function limiteDe(userId: string): Promise<number> {
  const { Item } = await db.send(
    new GetCommand({ TableName: tabelas.usuarios(), Key: { user_id: userId }, ConsistentRead: true }),
  );
  return typeof Item?.limite_disponivel === "number" ? Item.limite_disponivel : 0;
}

/**
 * Validacoes na MESMA ORDEM da Fase 1 -- quando dois erros valem ao mesmo
 * tempo, o primeiro da fila vence. Devolve a recusa, ou a intencao pronta
 * para cobrar.
 */
async function validar(
  userId: string,
  intencaoId: string,
  metodo: string,
): Promise<CompraRecusada | { intencao: Intencao; metodo: MetodoPagamento }> {
  const intencao = await lerIntencao(intencaoId);

  // 1. Nao existe OU nao e deste usuario -- mesma resposta de proposito,
  //    para nao vazar que a intencao de outra pessoa existe.
  if (!intencao || intencao.user_id !== userId) {
    return recusar("INTENCAO_INVALIDA", `A intencao ${intencaoId} nao existe ou nao pertence a este usuario.`);
  }
  // 2. Ja foi paga.
  if (intencao.status === "pago") {
    return recusar(
      "INTENCAO_JA_PAGA",
      `A intencao ${intencao.intencao_id} ja foi paga e nao pode ser cobrada de novo.`,
    );
  }
  // 3. Passou do prazo.
  if (Date.now() > new Date(intencao.expira_em).getTime()) {
    return recusar(
      "INTENCAO_EXPIRADA",
      `A intencao ${intencao.intencao_id} expirou em ${intencao.expira_em}. Registre uma nova intencao.`,
    );
  }
  // 4. Metodo fora dos aceitos.
  if (!METODOS_PAGAMENTO.includes(metodo as MetodoPagamento)) {
    return recusar("METODO_INVALIDO", `Metodo "${metodo}" nao e aceito. Use cartao ou pix.`);
  }
  // 5. Estoura o limite restante.
  const limite = await limiteDe(userId);
  if (intencao.valor_total > limite) {
    return recusar(
      "LIMITE_EXCEDIDO",
      `O valor de R$ ${intencao.valor_total.toFixed(2)} ultrapassa o limite disponivel de R$ ${limite.toFixed(2)}.`,
    );
  }
  return { intencao, metodo: metodo as MetodoPagamento };
}

/**
 * realizar_compra -- intencoes, usuarios, catalogo (estoque) e transacoes.
 *
 * Idempotencia: a cobranca e UMA transacao do DynamoDB com quatro escritas
 * condicionais. Ou todas acontecem, ou nenhuma:
 *   - intencao: so muda para "pago" se ainda estiver "pendente", for deste
 *     usuario e nao tiver expirado;
 *   - usuario: so debita se limite_disponivel >= valor;
 *   - catalogo: so baixa o estoque se houver unidades;
 *   - transacao: so grava se o transacao_id for novo.
 * Se a mesma chamada chegar duas vezes (ou duas ao mesmo tempo), a segunda
 * falha na condicao da intencao e vira INTENCAO_JA_PAGA -- sem cobrar duas
 * vezes e sem debitar o limite duas vezes.
 */
export const handler = comTratamento(
  "realizar_compra",
  async (evento: EventoTool<RealizarCompraArgs>): Promise<ResultadoCompra> => {
    const userId = exigirUsuario(evento);
    const args = evento.args ?? ({} as RealizarCompraArgs);
    if (typeof args.intencao_id !== "string" || !args.intencao_id) {
      throw new ArgumentoInvalido("Informe o intencao_id devolvido por registrar_intencao.");
    }
    const metodoInformado = typeof args.metodo_pagamento === "string" ? args.metodo_pagamento : "";

    let resultado: ResultadoCompra | undefined;

    for (let tentativa = 0; tentativa < 3 && !resultado; tentativa++) {
      const validacao = await validar(userId, args.intencao_id, metodoInformado);
      if ("status" in validacao) {
        resultado = validacao;
        break;
      }

      const { intencao, metodo } = validacao;
      const transacaoId = idAleatorio("tx");
      const agora = new Date().toISOString();

      try {
        await db.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: tabelas.intencoes(),
                  Key: { intencao_id: intencao.intencao_id },
                  UpdateExpression:
                    "SET #status = :pago, transacao_id = :tx, metodo_pagamento = :metodo, pago_em = :agora",
                  ConditionExpression: "#status = :pendente AND user_id = :usuario AND expira_em > :agora",
                  ExpressionAttributeNames: { "#status": "status" },
                  ExpressionAttributeValues: {
                    ":pago": "pago",
                    ":pendente": "pendente",
                    ":tx": transacaoId,
                    ":metodo": metodo,
                    ":usuario": userId,
                    ":agora": agora,
                  },
                },
              },
              {
                Update: {
                  TableName: tabelas.usuarios(),
                  Key: { user_id: userId },
                  UpdateExpression: "SET limite_disponivel = limite_disponivel - :valor",
                  ConditionExpression: "limite_disponivel >= :valor",
                  ExpressionAttributeValues: { ":valor": intencao.valor_total },
                },
              },
              {
                Update: {
                  TableName: tabelas.catalogo(),
                  Key: { id: intencao.produto_id },
                  UpdateExpression: "SET estoque = estoque - :qtd",
                  ConditionExpression: "estoque >= :qtd",
                  ExpressionAttributeValues: { ":qtd": intencao.quantidade },
                },
              },
              {
                Put: {
                  TableName: tabelas.transacoes(),
                  Item: {
                    transacao_id: transacaoId,
                    intencao_id: intencao.intencao_id,
                    user_id: userId,
                    valor: intencao.valor_total,
                    metodo_pagamento: metodo,
                    criada_em: agora,
                  },
                  ConditionExpression: "attribute_not_exists(transacao_id)",
                },
              },
            ],
          }),
        );

        resultado = {
          status: "aprovado",
          transacao_id: transacaoId,
          intencao_id: intencao.intencao_id,
          produto_nome: intencao.produto_nome,
          quantidade: intencao.quantidade,
          valor_debitado: intencao.valor_total,
          metodo_pagamento: metodo,
          limite_restante: centavos(await limiteDe(userId)),
          criada_em: agora,
        };
      } catch (e) {
        if (!(e instanceof TransactionCanceledException)) throw e;
        const motivos = (e.CancellationReasons ?? []).map((r) => r.Code);

        if (motivos[0] === "ConditionalCheckFailed") {
          // A intencao foi paga ou expirou no meio do caminho: revalida, e a
          // fila de validacao devolve o erro certo (respeitando a ordem).
          continue;
        }
        if (motivos[1] === "ConditionalCheckFailed") {
          // Outra compra consumiu o limite entre a validacao e a transacao.
          const limite = await limiteDe(userId);
          resultado = recusar(
            "LIMITE_EXCEDIDO",
            `O valor de R$ ${intencao.valor_total.toFixed(2)} ultrapassa o limite disponivel de R$ ${limite.toFixed(2)}.`,
          );
        } else if (motivos[2] === "ConditionalCheckFailed") {
          resultado = recusar(
            "ESTOQUE_INSUFICIENTE",
            `${intencao.produto_nome} nao tem mais ${intencao.quantidade} unidade(s) em estoque. Escolha outra quantidade ou produto.`,
          );
        }
        // Colisao de transacao_id ou conflito com transacao concorrente:
        // repete o laco com um novo id.
      }
    }

    resultado ??= recusar(
      "INTENCAO_INVALIDA",
      `Nao foi possivel concluir o pagamento da intencao ${args.intencao_id}. Tente novamente.`,
    );
    auditar({ user_id: userId, tool: "realizar_compra", args, resultado });
    return resultado;
  },
);
