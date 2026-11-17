import json
import logging
import os
from collections.abc import AsyncIterator
from typing import Any

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent
from strands.agent.conversation_manager import NullConversationManager
from strands.models import BedrockModel

from prompt import SYSTEM_PROMPT
from tools import TOOLS

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

MODEL_ID_PADRAO = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
MENSAGEM_ERRO = "Não consegui responder agora. Tente novamente em instantes."
MENSAGEM_PAYLOAD_INVALIDO = "Requisição inválida."

app = BedrockAgentCoreApp()


class PayloadInvalido(ValueError):
    pass


def parse_payload(payload: Any) -> tuple[str, str, list[dict[str, Any]]]:
    if not isinstance(payload, dict):
        raise PayloadInvalido("payload deve ser um objeto")

    usuario_id = payload.get("usuario_id")
    conversa_id = payload.get("conversa_id")
    mensagens = payload.get("mensagens")

    if not isinstance(usuario_id, str) or not usuario_id.strip():
        raise PayloadInvalido("usuario_id ausente")
    if not isinstance(conversa_id, str) or not conversa_id.strip():
        raise PayloadInvalido("conversa_id ausente")
    if not isinstance(mensagens, list) or not mensagens:
        raise PayloadInvalido("mensagens deve ser uma lista não vazia")

    ultima = mensagens[-1]
    if not isinstance(ultima, dict) or ultima.get("role") != "user" or not isinstance(ultima.get("content"), list):
        raise PayloadInvalido("a última mensagem deve ser do usuário")

    return usuario_id.strip(), conversa_id.strip(), mensagens


def create_agente(historico: list[dict[str, Any]]) -> Agent:
    return Agent(
        model=BedrockModel(
            model_id=os.environ.get("MODEL_ID", MODEL_ID_PADRAO),
            max_tokens=1024,
            temperature=0.2,
        ),
        system_prompt=SYSTEM_PROMPT,
        tools=TOOLS,
        messages=historico,
        conversation_manager=NullConversationManager(),
        callback_handler=None,
    )


def parse_resultado(conteudo: list[dict[str, Any]]) -> Any:
    texto = "".join(bloco["text"] for bloco in conteudo if "text" in bloco)
    try:
        return json.loads(texto)
    except json.JSONDecodeError:
        return texto


async def stream_resposta(
    agente: Agent,
    prompt: list[dict[str, Any]],
    estado: dict[str, str],
) -> AsyncIterator[dict[str, Any]]:
    chamadas: dict[str, dict[str, Any]] = {}

    async for evento in agente.stream_async(prompt, invocation_state=estado):
        texto = evento.get("data")
        if isinstance(texto, str) and texto:
            yield {"tipo": "texto", "texto": texto}

        mensagem = evento.get("message")
        if not isinstance(mensagem, dict):
            continue

        for bloco in mensagem.get("content", []):
            if "toolUse" in bloco:
                uso = bloco["toolUse"]
                chamadas[uso["toolUseId"]] = uso
            if "toolResult" in bloco:
                resultado = bloco["toolResult"]
                uso = chamadas.get(resultado["toolUseId"], {})
                yield {
                    "tipo": "tool",
                    "nome": uso.get("name"),
                    "argumentos": uso.get("input", {}),
                    "resultado": parse_resultado(resultado.get("content", [])),
                }


@app.entrypoint
async def invoke_agente(payload: Any) -> AsyncIterator[dict[str, Any]]:
    try:
        usuario_id, conversa_id, mensagens = parse_payload(payload)
    except PayloadInvalido as erro:
        logger.warning("payload inválido: %s", erro)
        yield {"tipo": "erro", "mensagem": MENSAGEM_PAYLOAD_INVALIDO}
        return

    historico = mensagens[:-1]
    tamanho_historico = len(historico)
    estado = {"usuario_id": usuario_id, "conversa_id": conversa_id}

    try:
        agente = create_agente(historico)
        async for evento in stream_resposta(agente, mensagens[-1]["content"], estado):
            yield evento
    except Exception:
        logger.exception("falha ao processar a conversa")
        yield {"tipo": "erro", "mensagem": MENSAGEM_ERRO}
        return

    yield {"tipo": "fim", "mensagens": agente.messages[tamanho_historico:]}


if __name__ == "__main__":
    app.run()
