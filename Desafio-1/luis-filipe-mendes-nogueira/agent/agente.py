from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from copy import deepcopy

from anthropic import AsyncAnthropicBedrockMantle
from strands import Agent
from strands.agent.conversation_manager import NullConversationManager
from strands.models.anthropic import AnthropicModel

from ferramentas import criar_ferramentas
from prompt import PROMPT_SISTEMA


REGIAO = "us-east-1"
MODELO_ID = "anthropic.claude-haiku-4-5"
ENDPOINT_MANTLE = (
    "https://bedrock-mantle.us-east-1.api.aws/anthropic"
)


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

    async with AsyncAnthropicBedrockMantle(
        aws_region=REGIAO,
        aws_profile=perfil_aws,
        base_url=ENDPOINT_MANTLE,
        timeout=60.0,
        max_retries=1,
    ) as client_modelo:
        modelo = AnthropicModel(
            model_id=MODELO_ID,
            max_tokens=1024,
            client=client_modelo,
        )

        agente = Agent(
            model=modelo,
            system_prompt=PROMPT_SISTEMA,
            tools=list(ferramentas.values()),
            messages=mensagens,
            conversation_manager=NullConversationManager(),
            callback_handler=None,
        )

        yield agente