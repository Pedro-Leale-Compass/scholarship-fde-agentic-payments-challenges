import logging
import os
from copy import deepcopy

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from botocore.config import Config

from agente import REGIAO, criar_agente


logger = logging.getLogger(__name__)
app = BedrockAgentCoreApp()

VARIAVEIS_FUNCOES = {
    "listar_catalogo": "LISTAR_CATALOGO_FUNCTION",
    "registrar_intencao": "REGISTRAR_INTENCAO_FUNCTION",
    "realizar_compra": "REALIZAR_COMPRA_FUNCTION",
}


def validar_entrada(payload):
    if not isinstance(payload, dict):
        raise ValueError("A entrada deve ser um objeto.")

    mensagem = payload.get("mensagem")
    if not isinstance(mensagem, str) or not mensagem.strip():
        raise ValueError("Mensagem deve ser um texto não vazio.")

    contexto = payload.get("contexto")
    if not isinstance(contexto, dict):
        raise ValueError("Contexto autenticado ausente.")

    usuario_id = contexto.get("usuario_id")
    if not isinstance(usuario_id, str) or not usuario_id.strip():
        raise ValueError("Identidade autenticada ausente.")

    historico = payload.get("historico", [])
    if not isinstance(historico, list):
        raise ValueError("Histórico deve ser uma lista.")

    return mensagem, usuario_id, historico


async def processar_requisicao(payload):
    # Este contrato é exclusivo do backend autorizado por IAM.
    # O backend obterá usuario_id do sub validado pelo Cognito.
    # O browser e o modelo não escolhem essa identidade.
    mensagem, usuario_id, historico = validar_entrada(payload)

    funcoes = {
        nome: os.environ[variavel]
        for nome, variavel in VARIAVEIS_FUNCOES.items()
    }

    cliente_lambda = boto3.client(
        "lambda",
        region_name=REGIAO,
        config=Config(
            connect_timeout=5,
            read_timeout=40,
            retries={
                "mode": "standard",
                "total_max_attempts": 1,
            },
        ),
    )

    try:
        async with criar_agente(
            client_lambda=cliente_lambda,
            usuario_id=usuario_id,
            funcoes=funcoes,
            historico=historico,
        ) as instancia:
            resultado = await instancia.invoke_async(mensagem)

            return {
                "resposta": str(resultado),
                "historico": deepcopy(instancia.messages),
            }
    finally:
        cliente_lambda.close()


@app.entrypoint
async def executar(payload):
    try:
        return await processar_requisicao(payload)
    except ValueError:
        return {
            "erro": "PAYLOAD_INVALIDO",
            "mensagem": "Entrada inválida para executar o agente.",
        }
    except Exception:
        logger.exception("Falha ao executar o agente.")

        return {
            "erro": "ERRO_INTERNO",
            "mensagem": (
                "Não foi possível concluir a solicitação. "
                "Não repita uma compra sem verificar seu resultado."
            ),
        }


if __name__ == "__main__":
    app.run()