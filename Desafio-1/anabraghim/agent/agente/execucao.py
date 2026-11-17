"""Um turno do chat: monta o agente com o histórico e transmite os eventos.

Eventos enviados à Lambda do chat (cada um vira uma linha SSE `data: {...}`):
    {"tipo": "texto", "texto": "<pedaço da resposta>"}
    {"tipo": "ferramenta", "nome": "<tool>"}             # para a UI mostrar "consultando..."
    {"tipo": "fim", "mensagens_novas": [...]}           # o que a Lambda do chat deve gravar
    {"tipo": "erro", "mensagem": "<texto amigável>"}    # nada deve ser gravado
"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator
from typing import Any

from strands import Agent
from strands.agent.conversation_manager import NullConversationManager
from strands.models import BedrockModel, Model

from agente.ferramentas import FERRAMENTAS
from agente.payload import Pedido, para_json
from agente.prompt import SYSTEM_PROMPT

logger = logging.getLogger(__name__)

# Mesmo teto de iterações da Fase 1 (MAX_ITERATIONS = 8).
MAX_TURNOS = 8

MENSAGEM_ERRO = "Não consegui responder agora por uma falha interna. Tente novamente em instantes."
MENSAGEM_LIMITE = (
    "Não consegui concluir o seu pedido de uma vez. Pode me dizer de novo, de forma mais direta, o que você precisa?"
)


def criar_modelo() -> Model:
    # Sem temperature/top_p: usa o padrão do modelo, aceito por todos os Claude
    # atuais (os mais novos recusam valores diferentes do padrão).
    return BedrockModel(
        model_id=os.environ["MODELO_ID"],
        region_name=os.environ.get("AWS_REGION", "us-east-1"),
        max_tokens=4096,
    )


def criar_agente(modelo: Model, historico: list[dict[str, Any]]) -> Agent:
    return Agent(
        model=modelo,
        system_prompt=SYSTEM_PROMPT,
        tools=FERRAMENTAS,
        messages=historico,
        # Histórico completo a cada turno, como na Fase 1: nada é cortado nem resumido.
        conversation_manager=NullConversationManager(),
        callback_handler=None,
    )


async def executar_turno(pedido: Pedido, modelo: Model) -> AsyncIterator[dict[str, Any]]:
    tamanho_historico = len(pedido.historico)
    agente = criar_agente(modelo, pedido.historico)
    ferramentas_anunciadas: set[str] = set()

    try:
        async for evento in agente.stream_async(
            pedido.nova_mensagem,
            invocation_state={"usuario_id": pedido.usuario_id},
            limits={"turns": MAX_TURNOS},
        ):
            texto = evento.get("data")
            if isinstance(texto, str) and texto:
                yield {"tipo": "texto", "texto": texto}
                continue
            uso = evento.get("current_tool_use")
            if isinstance(uso, dict):
                identificador = uso.get("toolUseId")
                if identificador and identificador not in ferramentas_anunciadas and uso.get("name"):
                    ferramentas_anunciadas.add(identificador)
                    yield {"tipo": "ferramenta", "nome": uso["name"]}
    except Exception:
        logger.exception("falha no turno do agente")
        yield {"tipo": "erro", "mensagem": MENSAGEM_ERRO}
        return

    # Só role e content: o Strands acrescenta campos internos (ex.: tracking_id) que não são do Bedrock.
    mensagens_novas = [
        {"role": mensagem["role"], "content": mensagem["content"]} for mensagem in agente.messages[tamanho_historico:]
    ]
    # Se o limite de turnos parou o loop depois de uma tool, a conversa terminaria numa
    # mensagem do usuário (toolResult) e o próximo turno seria rejeitado pelo Bedrock.
    # Fecha com uma resposta do assistente.
    if not mensagens_novas or mensagens_novas[-1].get("role") != "assistant":
        mensagens_novas.append({"role": "assistant", "content": [{"text": MENSAGEM_LIMITE}]})
        yield {"tipo": "texto", "texto": MENSAGEM_LIMITE}

    yield {"tipo": "fim", "mensagens_novas": para_json(mensagens_novas)}
