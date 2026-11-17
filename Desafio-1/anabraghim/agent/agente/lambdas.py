"""Invocação das Lambdas de tool.

O agente é o único que pode invocar as Lambdas (a role do runtime tem
lambda:InvokeFunction só nos 3 ARNs). O evento enviado é sempre
{ "usuario_id": <sub do Cognito>, "argumentos": <o que o modelo preencheu> }.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import boto3
from botocore.config import Config

logger = logging.getLogger(__name__)

# Nome da tool exposta ao modelo -> variável de ambiente com o nome/ARN da Lambda.
VARIAVEIS_DAS_TOOLS = {
    "listar_catalogo": "TOOL_LISTAR_CATALOGO",
    "registrar_intencao": "TOOL_REGISTRAR_INTENCAO",
    "realizar_compra": "TOOL_REALIZAR_COMPRA",
}

# Mesmo texto que a Lambda devolve em FALHA_NA_FERRAMENTA (tools/src/shared/handler.ts).
FALHA_NA_FERRAMENTA = {
    "status": "recusado",
    "erro": "FALHA_NA_FERRAMENTA",
    "mensagem": "Não foi possível concluir a operação agora por uma falha interna. Tente novamente em instantes.",
}

_cliente: Any = None


def cliente_lambda() -> Any:
    """Cliente criado uma vez por processo e reaproveitado entre invocações."""
    global _cliente
    if _cliente is None:
        _cliente = boto3.client(
            "lambda",
            region_name=os.environ.get("AWS_REGION", "us-east-1"),
            config=Config(
                # Acima do Timeout das tools (10 s): um timeout de leitura não pode
                # disparar retry de uma compra que ainda está rodando.
                read_timeout=20,
                connect_timeout=5,
                retries={"mode": "standard", "total_max_attempts": 2},
            ),
        )
    return _cliente


def _falha() -> str:
    return json.dumps(FALHA_NA_FERRAMENTA, ensure_ascii=False)


def invocar_tool(nome_tool: str, usuario_id: str | None, argumentos: dict[str, Any]) -> str:
    """Invoca a Lambda da tool e devolve o JSON do contrato como texto para o modelo.

    Qualquer falha (Lambda fora, erro não tratado, resposta inesperada) vira
    FALHA_NA_FERRAMENTA com mensagem amigável. O detalhe técnico vai só para o log.
    """
    if not usuario_id:
        # Nunca chama a tool sem identidade. O entrypoint já recusa antes, isto é defesa extra.
        logger.error("[%s] chamada sem usuario_id no contexto", nome_tool)
        return _falha()

    variavel = VARIAVEIS_DAS_TOOLS[nome_tool]
    funcao = os.environ.get(variavel)
    if not funcao:
        logger.error("[%s] variável de ambiente %s ausente", nome_tool, variavel)
        return _falha()

    evento = {"usuario_id": usuario_id, "argumentos": argumentos}
    try:
        resposta = cliente_lambda().invoke(
            FunctionName=funcao,
            InvocationType="RequestResponse",
            Payload=json.dumps(evento, ensure_ascii=False).encode("utf-8"),
        )
        corpo = resposta["Payload"].read()
        if resposta.get("FunctionError"):
            logger.error("[%s] erro na Lambda: %s", nome_tool, corpo[:1000])
            return _falha()
        resultado = json.loads(corpo)
    except Exception:
        logger.exception("[%s] falha ao invocar a Lambda", nome_tool)
        return _falha()

    if not isinstance(resultado, dict):
        logger.error("[%s] resposta inesperada da Lambda: %r", nome_tool, resultado)
        return _falha()
    return json.dumps(resultado, ensure_ascii=False)
