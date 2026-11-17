import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { Intencao, Produto, RegistrarIntencaoArgs } from "@desafio/shared";
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

const TTL_SEGUNDOS = Number(process.env.INTENCAO_TTL_SEGUNDOS ?? 300);

/**
 * registrar_intencao -- le o catalogo e grava na tabela de intencoes.
 * O valor_total e calculado aqui, a partir do preco do banco: o modelo
 * nao tem por onde informar valor.
 */
export const handler = comTratamento(
  "registrar_intencao",
  async (evento: EventoTool<RegistrarIntencaoArgs>) => {
    const userId = exigirUsuario(evento);
    const args = evento.args ?? ({} as RegistrarIntencaoArgs);

    // Na Fase 1 o zod barrava isso antes do handler; aqui validamos na mao.
    if (typeof args.produto_id !== "string" || !args.produto_id) {
      throw new ArgumentoInvalido("Informe o produto_id, exatamente como veio de listar_catalogo.");
    }
    if (!Number.isInteger(args.quantidade) || args.quantidade <= 0) {
      throw new ArgumentoInvalido("A quantidade deve ser um numero inteiro maior que zero.");
    }

    const { Item } = await db.send(
      new GetCommand({ TableName: tabelas.catalogo(), Key: { id: args.produto_id } }),
    );
    const produto = Item as Produto | undefined;

    if (!produto) {
      const resultado = {
        erro: "PRODUTO_INVALIDO",
        mensagem: `O produto ${args.produto_id} nao existe no catalogo. Use listar_catalogo para ver os ids validos.`,
      };
      auditar({ user_id: userId, tool: "registrar_intencao", args, resultado });
      return resultado;
    }

    if (produto.estoque < args.quantidade) {
      const resultado = {
        erro: "ESTOQUE_INSUFICIENTE",
        mensagem: `${produto.nome} tem apenas ${produto.estoque} unidade(s) em estoque, e foram pedidas ${args.quantidade}.`,
      };
      auditar({ user_id: userId, tool: "registrar_intencao", args, resultado });
      return resultado;
    }

    const agora = new Date();
    const base: Omit<Intencao, "intencao_id"> = {
      user_id: userId, // do token do Cognito, NUNCA do modelo
      produto_id: produto.id,
      produto_nome: produto.nome,
      quantidade: args.quantidade,
      valor_total: centavos(produto.preco * args.quantidade),
      moeda: produto.moeda,
      status: "pendente",
      criada_em: agora.toISOString(),
      expira_em: new Date(agora.getTime() + TTL_SEGUNDOS * 1000).toISOString(),
    };

    // O id tem so 3 bytes (formato da Fase 1). Como agora ele persiste,
    // a gravacao e condicional: se colidir com um existente, gera outro.
    for (let tentativa = 0; tentativa < 5; tentativa++) {
      const intencao: Intencao = { intencao_id: idAleatorio("int"), ...base };
      try {
        await db.send(
          new PutCommand({
            TableName: tabelas.intencoes(),
            Item: intencao,
            ConditionExpression: "attribute_not_exists(intencao_id)",
          }),
        );
        auditar({ user_id: userId, tool: "registrar_intencao", args, resultado: intencao });
        return intencao;
      } catch (e) {
        if (!(e instanceof ConditionalCheckFailedException)) throw e;
      }
    }
    throw new Error("Nao foi possivel gerar um intencao_id unico");
  },
);
