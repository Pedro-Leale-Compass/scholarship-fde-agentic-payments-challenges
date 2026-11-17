import json
import logging
import os
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError


logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

dynamodb = boto3.resource("dynamodb")
tabela = dynamodb.Table(os.environ["USUARIOS_TABLE"])

LIMITE_INICIAL_CENTAVOS = 50000


def responder(status, dados):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
        },
        "body": json.dumps(dados, ensure_ascii=False),
    }


def obter_ou_criar_perfil(usuario_id, username):
    chave = {"usuario_id": usuario_id}

    resposta = tabela.get_item(
        Key=chave,
        ConsistentRead=True,
    )

    existente = resposta.get("Item")

    if existente is not None:
        return existente

    novo_perfil = {
        "usuario_id": usuario_id,
        "username": username,
        "limite_centavos": LIMITE_INICIAL_CENTAVOS,
        "criado_em": datetime.now(timezone.utc).isoformat(),
    }

    try:
        tabela.put_item(
            Item=novo_perfil,
            ConditionExpression="attribute_not_exists(usuario_id)",
        )
        return novo_perfil

    except ClientError as erro:
        codigo = erro.response["Error"]["Code"]

        if codigo != "ConditionalCheckFailedException":
            raise

        # Outra requisição pode ter criado o perfil simultaneamente.
        resposta = tabela.get_item(
            Key=chave,
            ConsistentRead=True,
        )

        perfil = resposta.get("Item")

        if perfil is None:
            raise RuntimeError(
                "Perfil não encontrado após criação concorrente."
            )

        return perfil


def handler(event, context):
    claims = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
    )

    usuario_id = claims.get("sub")

    if not isinstance(usuario_id, str) or not usuario_id:
        return responder(
            401,
            {"mensagem": "Identidade autenticada não encontrada."},
        )

    username = claims.get("username")

    if not isinstance(username, str) or not username:
        username = usuario_id

    try:
        perfil = obter_ou_criar_perfil(usuario_id, username)

        return responder(
            200,
            {
                "id": perfil["usuario_id"],
                "username": perfil["username"],
                "limiteGasto": int(perfil["limite_centavos"]) / 100,
            },
        )

    except Exception:
        logger.exception("Falha ao consultar ou criar perfil.")

        return responder(
            500,
            {"mensagem": "Não foi possível carregar seu perfil."},
        )