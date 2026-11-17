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

    if "stream" in payload and not isinstance(payload["stream"], bool):
        raise ValueError("O campo stream deve ser booleano.")

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


async def processar_stream(payload):
    try:
        mensagem, usuario_id, historico = validar_entrada(payload)
    except ValueError:
        yield {
            "tipo": "erro",
            "erro": "PAYLOAD_INVALIDO",
            "mensagem": "Entrada inválida para executar o agente.",
        }
        return

    cliente_lambda = None
    instancia = None

    try:
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

        async with criar_agente(
            client_lambda=cliente_lambda,
            usuario_id=usuario_id,
            funcoes=funcoes,
            historico=historico,
        ) as instancia:
            resultado_final = None
            sequencia = 0
            fluxo = instancia.stream_async(mensagem)

            try:
                async for evento in fluxo:
                    texto = evento.get("data")
                    if isinstance(texto, str) and texto:
                        yield {
                            "tipo": "delta",
                            "texto": texto,
                        }

                    nova_mensagem = evento.get("message")
                    if isinstance(nova_mensagem, dict):
                        sequencia += 1
                        yield {
                            "tipo": "mensagem",
                            "sequencia": sequencia,
                            "mensagem": deepcopy(nova_mensagem),
                        }

                    if "result" in evento:
                        resultado_final = evento["result"]
            finally:
                await fluxo.aclose()

            if resultado_final is None:
                raise RuntimeError(
                    "O fluxo terminou sem resultado final."
                )

            ultimo_evento = {
                "tipo": "fim",
                "resposta": str(resultado_final),
                "historico": deepcopy(instancia.messages),
            }

    except Exception:
        logger.exception("Falha ao transmitir resposta do agente.")

        ultimo_evento = {
            "tipo": "erro",
            "erro": "ERRO_INTERNO",
            "mensagem": (
                "Não foi possível concluir a resposta. "
                "Verifique o resultado antes de repetir uma compra."
            ),
        }

        if instancia is not None:
            ultimo_evento["historico"] = deepcopy(
                instancia.messages
            )

    finally:
        if cliente_lambda is not None:
            cliente_lambda.close()

    yield ultimo_evento

@app.entrypoint
async def executar(payload):
    try:
        if (
            isinstance(payload, dict)
            and payload.get("stream") is True
        ):
            validar_entrada(payload)
            return processar_stream(payload)

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