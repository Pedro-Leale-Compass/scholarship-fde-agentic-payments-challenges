"""Entrypoint do Bedrock AgentCore Runtime (EntryPoint: main.py).

Só a Lambda do chat chama este runtime (InvokeAgentRuntime), com o usuario_id
tirado do JWT já validado pelo API Gateway.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Any

from bedrock_agentcore.runtime import BedrockAgentCoreApp

from agente import execucao
from agente.payload import PayloadInvalido, ler_pedido

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
logger = logging.getLogger("agente")

app = BedrockAgentCoreApp()


@app.entrypoint
async def invocar(payload: Any) -> AsyncIterator[dict[str, Any]]:
    try:
        pedido = ler_pedido(payload)
    except PayloadInvalido as erro:
        # Detalhe só no log; o payload não é logado porque contém a conversa do usuário.
        logger.warning("payload inválido: %s", erro)
        yield {"tipo": "erro", "mensagem": execucao.MENSAGEM_ERRO}
        return

    try:
        modelo = execucao.criar_modelo()
    except Exception:
        logger.exception("falha ao configurar o modelo")
        yield {"tipo": "erro", "mensagem": execucao.MENSAGEM_ERRO}
        return

    async for evento in execucao.executar_turno(pedido, modelo):
        yield evento


if __name__ == "__main__":
    app.run()
