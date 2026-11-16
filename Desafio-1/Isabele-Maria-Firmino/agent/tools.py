import json
import logging
import os
from typing import Any, Literal

import boto3
from botocore.config import Config
from strands import ToolContext, tool

logger = logging.getLogger(__name__)

ERRO_INTERNO = {
    "status": "erro",
    "erro": "ERRO_INTERNO",
    "mensagem": "Não foi possível concluir a operação agora. Tente novamente em instantes.",
}

_lambda_client = None


def get_lambda_client():
    global _lambda_client
    if _lambda_client is None:
        _lambda_client = boto3.client(
            "lambda",
            config=Config(retries={"max_attempts": 2, "mode": "standard"}, read_timeout=30),
        )
    return _lambda_client


def invoke_tool(variavel_lambda: str, tool_context: ToolContext, argumentos: dict[str, Any]) -> str:
    estado = tool_context.invocation_state
    evento = {
        "usuario_id": estado.get("usuario_id"),
        "conversa_id": estado.get("conversa_id"),
        "argumentos": argumentos,
    }
    try:
        resposta = get_lambda_client().invoke(
            FunctionName=os.environ[variavel_lambda],
            Payload=json.dumps(evento).encode("utf-8"),
        )
        corpo = resposta["Payload"].read()
        if resposta.get("FunctionError"):
            logger.error("lambda falhou: %s %s", variavel_lambda, resposta["FunctionError"])
            return json.dumps(ERRO_INTERNO, ensure_ascii=False)
        return json.dumps(json.loads(corpo), ensure_ascii=False)
    except Exception:
        logger.exception("falha ao invocar %s", variavel_lambda)
        return json.dumps(ERRO_INTERNO, ensure_ascii=False)


@tool(name="listar_catalogo", context=True)
def list_catalogo(tool_context: ToolContext, categoria: str | None = None) -> str:
    """Lista os produtos disponíveis, opcionalmente filtrados por categoria.

    Args:
        categoria: Categoria opcional, por exemplo: monitores.
    """
    argumentos = {} if categoria is None else {"categoria": categoria}
    return invoke_tool("LAMBDA_LISTAR_CATALOGO", tool_context, argumentos)


@tool(name="registrar_intencao", context=True)
def register_intencao(produto_id: str, quantidade: int, tool_context: ToolContext) -> str:
    """Registra por cinco minutos a intenção de comprar um produto. Não realiza pagamento.

    Args:
        produto_id: Identificador de um produto do catálogo, por exemplo: prod_001.
        quantidade: Quantidade desejada, inteiro maior que zero.
    """
    return invoke_tool(
        "LAMBDA_REGISTRAR_INTENCAO",
        tool_context,
        {"produto_id": produto_id, "quantidade": quantidade},
    )


@tool(name="realizar_compra", context=True)
def create_compra(intencao_id: str, metodo_pagamento: Literal["cartao", "pix"], tool_context: ToolContext) -> str:
    """Confirma o pagamento de uma intenção pendente usando cartão ou pix.

    Args:
        intencao_id: Identificador retornado por registrar_intencao.
        metodo_pagamento: Método de pagamento.
    """
    return invoke_tool(
        "LAMBDA_REALIZAR_COMPRA",
        tool_context,
        {"intencao_id": intencao_id, "metodo_pagamento": metodo_pagamento},
    )


TOOLS = [list_catalogo, register_intencao, create_compra]
