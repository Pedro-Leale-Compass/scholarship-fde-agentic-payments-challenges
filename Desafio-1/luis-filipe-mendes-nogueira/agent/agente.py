from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from copy import deepcopy

import boto3
from botocore.config import Config
from strands import Agent
from strands.agent.conversation_manager import NullConversationManager
from strands.models import BedrockModel

from ferramentas import criar_ferramentas
from prompt import PROMPT_SISTEMA


REGIAO = "us-east-1"
MODELO_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"


@asynccontextmanager
async def criar_agente(
    client_lambda,
    usuario_id: str,
    funcoes: dict[str, str],
    historico: list[dict] | None = None,
    perfil_aws: str | None = None,
) -> AsyncIterator[Agent]:
    if historico is not None and not isinstance(historico, list):
        raise ValueError("Histórico deve ser uma lista de mensagens.")

    ferramentas = criar_ferramentas(
        client_lambda=client_lambda,
        usuario_id=usuario_id,
        funcoes=funcoes,
    )

    mensagens = deepcopy(historico) if historico is not None else []

    # Localmente, usa o perfil informado.
    # No AgentCore, perfil_aws=None permite usar a role do Runtime.
    sessao = boto3.Session(
        profile_name=perfil_aws,
        region_name=REGIAO,
    )

    modelo = BedrockModel(
        model_id=MODELO_ID,
        boto_session=sessao,
        boto_client_config=Config(
            connect_timeout=5,
            read_timeout=60,
            retries={
                "mode": "standard",
                "total_max_attempts": 2,
            },
        ),
        max_tokens=1024,
        streaming=True,
    )

    try:
        agente = Agent(
            model=modelo,
            system_prompt=PROMPT_SISTEMA,
            tools=list(ferramentas.values()),
            messages=mensagens,
            conversation_manager=NullConversationManager(),
            callback_handler=None,
        )

        yield agente
    finally:
        modelo.client.close()