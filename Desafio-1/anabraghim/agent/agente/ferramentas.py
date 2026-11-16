"""Tools expostas ao modelo.

O usuario_id NÃO é parâmetro de nenhuma tool: ele vem do invocation_state,
preenchido pelo entrypoint a partir do payload da Lambda do chat (claims.sub do
JWT). O modelo não vê nem controla esse valor. Equivale ao _meta do MCP da Fase 1.
"""

from __future__ import annotations

from typing import Any

from strands import ToolContext, tool

from agente.lambdas import invocar_tool


def _usuario(contexto: ToolContext) -> str | None:
    return contexto.invocation_state.get("usuario_id")


@tool(context=True)
def listar_catalogo(tool_context: ToolContext, categoria: str | None = None) -> str:
    """Retorna os produtos disponíveis no catálogo, com filtro opcional por categoria.

    Args:
        categoria: Filtro opcional por categoria de produto.
    """
    argumentos: dict[str, Any] = {}
    if categoria is not None:
        argumentos["categoria"] = categoria
    return invocar_tool("listar_catalogo", _usuario(tool_context), argumentos)


@tool(context=True)
def registrar_intencao(tool_context: ToolContext, produto_id: str, quantidade: int) -> str:
    """Registra a intenção de compra de um item do catálogo e devolve um identificador. Nenhum pagamento é feito nesta etapa.

    Args:
        produto_id: Id do produto, exatamente como retornado por listar_catalogo.
        quantidade: Quantidade desejada, inteiro maior que zero.
    """
    return invocar_tool(
        "registrar_intencao",
        _usuario(tool_context),
        {"produto_id": produto_id, "quantidade": quantidade},
    )


# metodo_pagamento é string e não enum: com enum o SDK recusaria antes da Lambda e
# METODO_INVALIDO não voltaria no formato padrão (erro aprendido na Fase 1).
@tool(context=True)
def realizar_compra(tool_context: ToolContext, intencao_id: str, metodo_pagamento: str) -> str:
    """Executa o pagamento de uma intenção de compra previamente registrada. O valor vem da intenção, não é informado aqui.

    Args:
        intencao_id: Identificador devolvido por registrar_intencao nesta conversa.
        metodo_pagamento: Método de pagamento: cartao ou pix.
    """
    return invocar_tool(
        "realizar_compra",
        _usuario(tool_context),
        {"intencao_id": intencao_id, "metodo_pagamento": metodo_pagamento},
    )


FERRAMENTAS = [listar_catalogo, registrar_intencao, realizar_compra]
