import logging
import os
import time

import boto3

from erros import criar_erro
from expiracao import expirar_intencoes_vencidas


logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


def listar_catalogo(
    client,
    tabela_catalogo,
    tabela_intencoes,
    categoria=None,
    agora_epoch=None,
):
    if categoria is not None and not isinstance(categoria, str):
        raise ValueError("Categoria deve ser uma string.")

    if agora_epoch is None:
        agora_epoch = int(time.time())

    expirar_intencoes_vencidas(
        client=client,
        tabela_intencoes=tabela_intencoes,
        tabela_catalogo=tabela_catalogo,
        agora_epoch=agora_epoch,
    )

    produtos = []
    ultima_chave = None

    while True:
        parametros = {
            "TableName": tabela_catalogo,
            "ConsistentRead": True,
        }

        if categoria:
            parametros.update(
                {
                    "FilterExpression": "#categoria = :categoria",
                    "ExpressionAttributeNames": {
                        "#categoria": "categoria_normalizada",
                    },
                    "ExpressionAttributeValues": {
                        ":categoria": {"S": categoria.lower()},
                    },
                }
            )

        if ultima_chave:
            parametros["ExclusiveStartKey"] = ultima_chave

        resposta = client.scan(**parametros)

        for evento in resposta.get("Items", []):
            produtos.append(
                {
                    "id": evento["evento_id"]["S"],
                    "nome": evento["nome"]["S"],
                    "preco": int(evento["preco_centavos"]["N"]) / 100,
                    "moeda": evento["moeda"]["S"],
                    "estoque": int(evento["vagas_restantes"]["N"]),
                }
            )

        ultima_chave = resposta.get("LastEvaluatedKey")

        if not ultima_chave:
            break

    produtos.sort(key=lambda produto: produto["id"])

    return {"produtos": produtos}


def handler(event, context):
    try:
        if not isinstance(event, dict):
            raise ValueError("Evento inválido.")

        argumentos = event.get("argumentos", {})
        contexto = event.get("contexto", {})

        if not isinstance(argumentos, dict):
            raise ValueError("Argumentos inválidos.")

        if not isinstance(contexto, dict):
            raise ValueError("Contexto inválido.")

        usuario_id = contexto.get("usuario_id")

        if not isinstance(usuario_id, str) or not usuario_id:
            raise ValueError("Contexto autenticado ausente.")

        client = boto3.client("dynamodb")

        return listar_catalogo(
            client=client,
            tabela_catalogo=os.environ["CATALOGO_TABLE"],
            tabela_intencoes=os.environ["INTENCOES_TABLE"],
            categoria=argumentos.get("categoria"),
        )

    except Exception:
        logger.exception("Falha ao executar listar_catalogo.")
        return criar_erro("ERRO_INTERNO")