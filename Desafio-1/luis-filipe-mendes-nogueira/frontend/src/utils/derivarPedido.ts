import type { Content, EventoCatalogo } from "../types";
import type { MensagemStrands, PedidoChat } from "../types/chat";
import { registro } from "../types/chat";
import { historicoParaContent } from "./strands";

type Historico = Content[] | MensagemStrands[];

function normalizar(historico: Historico): Content[] {
  if (!historico.length) return [];

  return "parts" in historico[0]
    ? historico as Content[]
    : historicoParaContent(historico as MensagemStrands[]);
}

function texto(valor: unknown): string | undefined {
  return typeof valor === "string" && valor ? valor : undefined;
}

function numero(valor: unknown, padrao: number): number {
  return typeof valor === "number" && Number.isFinite(valor)
    ? valor
    : padrao;
}

export function extrairCatalogoConhecido(
  historico: Historico,
): Record<string, EventoCatalogo> {
  const catalogo: Record<string, EventoCatalogo> = {};

  for (const mensagem of normalizar(historico)) {
    for (const parte of mensagem.parts) {
      if (
        !("functionResponse" in parte) ||
        parte.functionResponse.name !== "listar_catalogo"
      ) {
        continue;
      }

      const resposta = registro(parte.functionResponse.response.content);
      if (!Array.isArray(resposta?.produtos)) continue;

      for (const bruto of resposta.produtos) {
        const item = registro(bruto);

        if (
          item &&
          typeof item.id === "string" &&
          typeof item.nome === "string" &&
          typeof item.preco === "number" &&
          typeof item.moeda === "string" &&
          typeof item.estoque === "number"
        ) {
          catalogo[item.id] = item as unknown as EventoCatalogo;
        }
      }
    }
  }

  return catalogo;
}

export function extrairPedidoAtual(
  historico: Historico,
): PedidoChat | null {
  const catalogo = extrairCatalogoConhecido(historico);
  const argumentos = new Map<string, Record<string, unknown>>();
  let pedido: PedidoChat | null = null;

  for (const mensagem of normalizar(historico)) {
    for (const parte of mensagem.parts) {
      if ("functionCall" in parte) {
        argumentos.set(parte.functionCall.name, parte.functionCall.args);
        continue;
      }

      if (!("functionResponse" in parte)) continue;

      const nome = parte.functionResponse.name;
      const resposta = registro(parte.functionResponse.response.content);
      if (!resposta) continue;

      const args = argumentos.get(nome) ?? {};

      if (nome === "registrar_intencao") {
        const eventoId =
          texto(resposta.eventoId) ??
          texto(resposta.evento_id) ??
          texto(resposta.produto_id) ??
          texto(args.evento_id) ??
          "";

        const intencaoId =
          texto(resposta.intencaoId) ?? texto(resposta.intencao_id);

        if (!intencaoId && resposta.status !== "recusado") continue;

        pedido = {
          eventoId,
          nome: catalogo[eventoId]?.nome ?? "seu evento",
          quantidade: numero(resposta.quantidade, numero(args.quantidade, 1)),
          valorTotal: numero(
            resposta.valorTotal,
            numero(resposta.valor_total, 0),
          ),
          moeda: texto(resposta.moeda) ?? "BRL",
          status: resposta.status === "recusado" ? "recusado" : "pendente",
          ...(intencaoId ? { intencaoId } : {}),
          ...(texto(resposta.expiraEm)
            ? { expiraEm: texto(resposta.expiraEm) }
            : {}),
          ...(texto(resposta.erro)
            ? { codigoErro: texto(resposta.erro) }
            : {}),
          ...(texto(resposta.mensagem)
            ? { mensagemErro: texto(resposta.mensagem) }
            : {}),
        };

        continue;
      }

      if (nome !== "realizar_compra" || !pedido) continue;

      const alvo =
        texto(resposta.intencao_id) ??
        texto(args.intencao_id) ??
        pedido.intencaoId;

      if (alvo && pedido.intencaoId && alvo !== pedido.intencaoId) {
        continue;
      }

      if (resposta.status === "aprovado") {
        const metodo = resposta.metodo_pagamento;

        pedido = {
          ...pedido,
          status: "aprovado",
          valorTotal: numero(resposta.valor, pedido.valorTotal),
          mensagemErro: undefined,
          codigoErro: undefined,
          ...(metodo === "pix" || metodo === "cartao"
            ? { metodoPagamento: metodo }
            : {}),
          ...(texto(resposta.transacao_id)
            ? { transacaoId: texto(resposta.transacao_id) }
            : {}),
        };
      } else if (
        resposta.status === "recusado" &&
        pedido.status !== "aprovado"
      ) {
        pedido = {
          ...pedido,
          status: "recusado",
          codigoErro: texto(resposta.erro),
          mensagemErro: texto(resposta.mensagem),
        };
      }
    }
  }

  return pedido;
}
