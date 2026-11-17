"""Contrato entre a Lambda do chat e o agente.

Entrada (InvokeAgentRuntime):
    {
      "usuario_id": "<sub do Cognito>",
      "mensagens": [ <histórico no formato do Strands/Bedrock>, ..., <nova mensagem do usuário> ]
    }

A última mensagem é a nova, sempre do usuário e só com texto. As anteriores são o
histórico completo gravado pela Lambda do chat, incluindo toolUse/toolResult, para
que o modelo saiba de onde vieram os ids (regra da Fase 1).

Bytes (ex.: raciocínio criptografado do modelo) não existem em JSON. Eles viajam
como {"__bytes_b64": "..."} e são reconstruídos aqui, para o histórico voltar ao
modelo exatamente como ele produziu.
"""

from __future__ import annotations

import base64
import re
from dataclasses import dataclass
from typing import Any

GUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)

MAX_MENSAGENS = 400
MAX_CARACTERES_MENSAGEM = 4000
# Tipos de bloco que o histórico pode conter. Imagem, documento etc. não fazem parte do chat.
BLOCOS_PERMITIDOS = {"text", "toolUse", "toolResult", "reasoningContent"}
CHAVE_BYTES = "__bytes_b64"


class PayloadInvalido(ValueError):
    """Payload fora do contrato. A mensagem vai só para o log."""


@dataclass(frozen=True)
class Pedido:
    usuario_id: str
    historico: list[dict[str, Any]]
    nova_mensagem: list[dict[str, Any]]


def para_json(valor: Any) -> Any:
    """Converte bytes em {"__bytes_b64": ...}, recursivamente."""
    if isinstance(valor, (bytes, bytearray)):
        return {CHAVE_BYTES: base64.b64encode(bytes(valor)).decode("ascii")}
    if isinstance(valor, dict):
        return {chave: para_json(item) for chave, item in valor.items()}
    if isinstance(valor, (list, tuple)):
        return [para_json(item) for item in valor]
    return valor


def de_json(valor: Any) -> Any:
    """Inverso de para_json."""
    if isinstance(valor, dict):
        if set(valor) == {CHAVE_BYTES} and isinstance(valor[CHAVE_BYTES], str):
            return base64.b64decode(valor[CHAVE_BYTES])
        return {chave: de_json(item) for chave, item in valor.items()}
    if isinstance(valor, list):
        return [de_json(item) for item in valor]
    return valor


def _validar_mensagem(mensagem: Any, indice: int) -> None:
    if not isinstance(mensagem, dict) or mensagem.get("role") not in ("user", "assistant"):
        raise PayloadInvalido(f"mensagem {indice}: role inválido")
    conteudo = mensagem.get("content")
    if not isinstance(conteudo, list) or not conteudo:
        raise PayloadInvalido(f"mensagem {indice}: content precisa ser lista não vazia")
    for bloco in conteudo:
        if not isinstance(bloco, dict) or len(bloco) != 1 or next(iter(bloco)) not in BLOCOS_PERMITIDOS:
            raise PayloadInvalido(f"mensagem {indice}: bloco não permitido")


def ler_pedido(payload: Any) -> Pedido:
    if not isinstance(payload, dict):
        raise PayloadInvalido("payload precisa ser objeto")

    usuario_id = payload.get("usuario_id")
    if not isinstance(usuario_id, str) or not GUID.match(usuario_id):
        raise PayloadInvalido("usuario_id ausente ou inválido")

    mensagens = payload.get("mensagens")
    if not isinstance(mensagens, list) or not mensagens:
        raise PayloadInvalido("mensagens precisa ser lista não vazia")
    if len(mensagens) > MAX_MENSAGENS:
        raise PayloadInvalido("histórico longo demais")
    for indice, mensagem in enumerate(mensagens):
        _validar_mensagem(mensagem, indice)

    nova = mensagens[-1]
    if nova["role"] != "user":
        raise PayloadInvalido("a última mensagem precisa ser do usuário")
    # A mensagem nova vem do usuário: só texto, nunca toolResult forjado.
    textos = [bloco.get("text") for bloco in nova["content"]]
    if not all(isinstance(texto, str) for texto in textos):
        raise PayloadInvalido("a mensagem nova só pode ter texto")
    total = sum(len(texto) for texto in textos)
    if total == 0 or not any(texto.strip() for texto in textos) or total > MAX_CARACTERES_MENSAGEM:
        raise PayloadInvalido("texto da mensagem nova vazio ou longo demais")

    return Pedido(
        usuario_id=usuario_id,
        historico=de_json(mensagens[:-1]),
        nova_mensagem=[{"text": texto} for texto in textos],
    )
