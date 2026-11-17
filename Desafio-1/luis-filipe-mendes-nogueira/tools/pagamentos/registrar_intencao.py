import logging
import os
import time
from datetime import datetime, timezone
from uuid import uuid4

import boto3

from erros import criar_erro
from expiracao import expirar_intencoes_vencidas


logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

VALIDADE_SEGUNDOS = 300


def buscar_evento(client, tabela_catalogo, evento_id):
    resposta = client.get_item(
        TableName=tabela_catalogo,
        Key={"evento_id": {"S": evento_id}},
        ConsistentRead=True,
    )

    return resposta.get("Item")


def registrar_intencao(
    client,
    tabela_catalogo,
    tabela_intencoes,
    usuario_id,
    evento_id,
    quantidade,
    agora_epoch=None,
):
    if not isinstance(usuario_id, str) or not usuario_id:
        raise ValueError("Contexto autenticado ausente.")

    if not isinstance(evento_id, str) or not evento_id:
        raise ValueError("Identificador de evento inválido.")

    # bool também é considerado int pelo Python.
    # type(...) is int impede aceitar True como quantidade 1.
    if type(quantidade) is not int or quantidade <= 0:
        raise ValueError("Quantidade deve ser um inteiro positivo.")

    if agora_epoch is None:
        agora_epoch = int(time.time())

    expirar_intencoes_vencidas(
        client=client,
        tabela_intencoes=tabela_intencoes,
        tabela_catalogo=tabela_catalogo,
        agora_epoch=agora_epoch,
    )

    evento = buscar_evento(client, tabela_catalogo, evento_id)

    if evento is None:
        return criar_erro("INTENCAO_INVALIDA")

    estoque = int(evento["vagas_restantes"]["N"])
    preco_centavos = int(evento["preco_centavos"]["N"])
    moeda = evento["moeda"]["S"]

    if preco_centavos < 0:
        raise ValueError("Preço armazenado inválido.")

    if estoque < quantidade:
        return criar_erro("VAGAS_INSUFICIENTES")

    valor_total_centavos = preco_centavos * quantidade
    intencao_id = f"int_{uuid4().hex}"
    expira_em_epoch = agora_epoch + VALIDADE_SEGUNDOS

    expira_em = (
        datetime.fromtimestamp(expira_em_epoch, timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )

    item = {
        "intencao_id": {"S": intencao_id},
        "evento_id": {"S": evento_id},
        "usuario_id": {"S": usuario_id},
        "quantidade": {"N": str(quantidade)},
        "valor_total_centavos": {"N": str(valor_total_centavos)},
        "moeda": {"S": moeda},
        "status": {"S": "pendente"},
        "expira_em_epoch": {"N": str(expira_em_epoch)},
        "expira_em": {"S": expira_em},
    }

    try:
        client.transact_write_items(
            ClientRequestToken=intencao_id,
            TransactItems=[
                {
                    "Update": {
                        "TableName": tabela_catalogo,
                        "Key": {
                            "evento_id": {"S": evento_id},
                        },
                        "UpdateExpression": (
                            "SET vagas_restantes = "
                            "vagas_restantes - :quantidade"
                        ),
                        "ConditionExpression": (
                            "attribute_exists(evento_id) "
                            "AND vagas_restantes >= :quantidade "
                            "AND preco_centavos = :preco "
                            "AND moeda = :moeda"
                        ),
                        "ExpressionAttributeValues": {
                            ":quantidade": {"N": str(quantidade)},
                            ":preco": {"N": str(preco_centavos)},
                            ":moeda": {"S": moeda},
                        },
                    }
                },
                {
                    "Put": {
                        "TableName": tabela_intencoes,
                        "Item": item,
                        "ConditionExpression": (
                            "attribute_not_exists(intencao_id)"
                        ),
                    }
                },
            ],
        )

    except client.exceptions.TransactionCanceledException as erro:
        motivos = erro.response.get("CancellationReasons", [])

        reserva_recusada = (
            len(motivos) == 2
            and motivos[0].get("Code") == "ConditionalCheckFailed"
            and motivos[1].get("Code") in (None, "None")
        )

        if not reserva_recusada:
            raise

        # O catálogo pode ter mudado entre a leitura e a transação.
        atual = buscar_evento(client, tabela_catalogo, evento_id)

        if atual is None:
            return criar_erro("INTENCAO_INVALIDA")

        if int(atual["vagas_restantes"]["N"]) < quantidade:
            return criar_erro("VAGAS_INSUFICIENTES")

        # Por exemplo: preço ou moeda alterados durante a operação.
        # Nenhuma reserva foi confirmada nesse caso.
        logger.warning(
            "Reserva recusada após alteração concorrente do catálogo."
        )
        return criar_erro("ERRO_INTERNO")

    return {
        "intencaoId": intencao_id,
        "eventoId": evento_id,
        "quantidade": quantidade,
        "valorTotal": valor_total_centavos / 100,
        "moeda": moeda,
        "status": "pendente",
        "usuarioId": usuario_id,
        "expiraEm": expira_em,
    }


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

        return registrar_intencao(
            client=boto3.client("dynamodb"),
            tabela_catalogo=os.environ["CATALOGO_TABLE"],
            tabela_intencoes=os.environ["INTENCOES_TABLE"],
            usuario_id=usuario_id,
            evento_id=argumentos.get("evento_id"),
            quantidade=argumentos.get("quantidade"),
        )

    except Exception:
        logger.exception("Falha ao executar registrar_intencao.")
        return criar_erro("ERRO_INTERNO")