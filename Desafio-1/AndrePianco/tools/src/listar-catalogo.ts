import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { ListarCatalogoArgs, Produto } from "@desafio/shared";
import { db, tabelas } from "./lib/db.js";
import { auditar, comTratamento, exigirUsuario, type EventoTool } from "./lib/comum.js";

/**
 * listar_catalogo -- le apenas a tabela de catalogo.
 * Contrato da Fase 1: { produtos: Produto[] }, filtro opcional por categoria.
 */
export const handler = comTratamento(
  "listar_catalogo",
  async (evento: EventoTool<ListarCatalogoArgs>) => {
    const userId = exigirUsuario(evento);
    const args = evento.args ?? {};
    const categoria = typeof args.categoria === "string" && args.categoria ? args.categoria : undefined;

    // Catalogo pequeno (dezenas de itens): Scan e suficiente e barato.
    const produtos: Produto[] = [];
    let inicio: Record<string, unknown> | undefined;
    do {
      const pagina = await db.send(
        new ScanCommand({
          TableName: tabelas.catalogo(),
          ExclusiveStartKey: inicio,
          ...(categoria && {
            FilterExpression: "categoria = :c",
            ExpressionAttributeValues: { ":c": categoria },
          }),
        }),
      );
      produtos.push(...((pagina.Items ?? []) as Produto[]));
      inicio = pagina.LastEvaluatedKey;
    } while (inicio);

    produtos.sort((a, b) => a.id.localeCompare(b.id));
    const resultado = { produtos };
    auditar({ user_id: userId, tool: "listar_catalogo", args, resultado: { total: produtos.length } });
    return resultado;
  },
);
