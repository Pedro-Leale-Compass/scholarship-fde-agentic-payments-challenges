import logging
import os
import time
from datetime import datetime, timezone
from uuid import uuid4

import boto3

from erros import criar_erro
from expiracao import expirar_intencao


logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

MAX_TENTATIVAS = 3


def buscar_item(client, tabela, campo, valor):
    resposta = client.get_item(
        TableName=tabela,
        Key={campo: {"S": valor}},
        ConsistentRead=True,
    )

    return resposta.get("Item")


def avaliar_intencao(intencao, usuario_id, agora):
    if (
        intencao is None
        or intencao["usuario_id"]["S"] != usuario_id
    ):
        return criar_erro("INTENCAO_INVALIDA")

    status = intencao["status"]["S"]

    if status == "paga":
        return criar_erro("INTENCAO_JA_PAGA")

    if status == "expirada":
        return criar_erro("INTENCAO_EXPIRADA")

    if status != "pendente":
        return criar_erro("ERRO_INTERNO")

    if int(intencao["expira_em_epoch"]["N"]) <= agora:
        return criar_erro("INTENCAO_EXPIRADA")

    return None


def realizar_compra(
    client,
    tabela_usuarios,
    tabela_intencoes,
    tabela_transacoes,
    tabela_catalogo,
    usuario_id,
    intencao_id,
    metodo_pagamento,
    agora_epoch=None,
):
    if not isinstance(usuario_id, str) or not usuario_id:
        raise ValueError("Contexto autenticado ausente.")

    if metodo_pagamento not in ("cartao", "pix"):
        return criar_erro("METODO_INVALIDO")

    if not isinstance(intencao_id, str) or not intencao_id:
        return criar_erro("INTENCAO_INVALIDA")

    # A última passagem apenas relê o estado para classificar a recusa.
    for tentativa in range(MAX_TENTATIVAS + 1):
        intencao = buscar_item(
            client,
            tabela_intencoes,
            "intencao_id",
            intencao_id,
        )

        agora = (
            int(time.time())
            if agora_epoch is None
            else agora_epoch
        )

        erro = avaliar_intencao(intencao, usuario_id, agora)

        if erro is not None:
            if (
                erro["erro"] == "INTENCAO_EXPIRADA"
                and intencao["status"]["S"] == "pendente"
            ):
                expirou = expirar_intencao(
                    client=client,
                    tabela_intencoes=tabela_intencoes,
                    tabela_catalogo=tabela_catalogo,
                    intencao=intencao,
                    agora_epoch=agora,
                )

                if not expirou:
                    # Pode ter ocorrido pagamento ou expiração concorrente.
                    atual = buscar_item(
                        client,
                        tabela_intencoes,
                        "intencao_id",
                        intencao_id,
                    )

                    return (
                        avaliar_intencao(atual, usuario_id, agora)
                        or criar_erro("ERRO_INTERNO")
                    )

            return erro

        valor_centavos = int(
            intencao["valor_total_centavos"]["N"]
        )

        if valor_centavos < 0:
            raise ValueError("Valor armazenado inválido.")

        usuario = buscar_item(
            client,
            tabela_usuarios,
            "usuario_id",
            usuario_id,
        )

        if usuario is None:
            # O perfil deve ter sido inicializado pelo backend.
            return criar_erro("ERRO_INTERNO")

        limite_centavos = int(usuario["limite_centavos"]["N"])

        if limite_centavos < valor_centavos:
            return criar_erro("LIMITE_EXCEDIDO")

        if tentativa == MAX_TENTATIVAS:
            return criar_erro("ERRO_INTERNO")

        agora = (
            int(time.time())
            if agora_epoch is None
            else agora_epoch
        )

        # O prazo pode ter acabado durante a consulta do perfil.
        if int(intencao["expira_em_epoch"]["N"]) <= agora:
            continue

        transacao_id = f"tx_{uuid4().hex}"
        data = (
            datetime.fromtimestamp(agora, timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        )

        try:
            client.transact_write_items(
                ClientRequestToken=transacao_id,
                TransactItems=[
                    {
                        "Update": {
                            "TableName": tabela_intencoes,
                            "Key": {
                                "intencao_id": {"S": intencao_id},
                            },
                            "UpdateExpression": (
                                "SET #status = :paga, "
                                "transacao_id = :transacao, "
                                "metodo_pagamento = :metodo, "
                                "paga_em = :data"
                            ),
                            "ConditionExpression": (
                                "usuario_id = :usuario "
                                "AND #status = :pendente "
                                "AND expira_em_epoch > :agora "
                                "AND valor_total_centavos = :valor"
                            ),
                            "ExpressionAttributeNames": {
                                "#status": "status",
                            },
                            "ExpressionAttributeValues": {
                                ":usuario": {"S": usuario_id},
                                ":pendente": {"S": "pendente"},
                                ":paga": {"S": "paga"},
                                ":agora": {"N": str(agora)},
                                ":valor": {"N": str(valor_centavos)},
                                ":transacao": {"S": transacao_id},
                                ":metodo": {"S": metodo_pagamento},
                                ":data": {"S": data},
                            },
                        }
                    },
                    {
                        "Update": {
                            "TableName": tabela_usuarios,
                            "Key": {
                                "usuario_id": {"S": usuario_id},
                            },
                            "UpdateExpression": (
                                "SET limite_centavos = "
                                "limite_centavos - :valor"
                            ),
                            "ConditionExpression": (
                                "attribute_exists(usuario_id) "
                                "AND limite_centavos = :limite "
                                "AND limite_centavos >= :valor"
                            ),
                            "ExpressionAttributeValues": {
                                ":limite": {"N": str(limite_centavos)},
                                ":valor": {"N": str(valor_centavos)},
                            },
                        }
                    },
                    {
                        "Put": {
                            "TableName": tabela_transacoes,
                            "Item": {
                                "intencao_id": {"S": intencao_id},
                                "transacao_id": {"S": transacao_id},
                                "usuario_id": {"S": usuario_id},
                                "valor_centavos": {
                                    "N": str(valor_centavos),
                                },
                                "moeda": intencao["moeda"],
                                "metodo_pagamento": {
                                    "S": metodo_pagamento,
                                },
                                "data": {"S": data},
                            },
                            "ConditionExpression": (
                                "attribute_not_exists(intencao_id)"
                            ),
                        }
                    },
                ],
            )

        except client.exceptions.TransactionCanceledException as falha:
            motivos = falha.response.get("CancellationReasons", [])

            codigos = [
                motivo.get("Code")
                for motivo in motivos
            ]

            disputa_reprocessavel = (
                len(codigos) == 3
                and any(
                    codigo in (
                        "ConditionalCheckFailed",
                        "TransactionConflict",
                    )
                    for codigo in codigos
                )
                and all(
                    codigo in (
                        None,
                        "None",
                        "ConditionalCheckFailed",
                        "TransactionConflict",
                    )
                    for codigo in codigos
                )
            )

            if disputa_reprocessavel:
                continue

            raise

        return {
            "status": "aprovado",
            "transacao_id": transacao_id,
            "intencao_id": intencao_id,
            "valor": valor_centavos / 100,
            "metodo_pagamento": metodo_pagamento,
            "limite_restante": (
                limite_centavos - valor_centavos
            ) / 100,
            "data": data,
        }

    return criar_erro("ERRO_INTERNO")


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

        return realizar_compra(
            client=boto3.client("dynamodb"),
            tabela_usuarios=os.environ["USUARIOS_TABLE"],
            tabela_intencoes=os.environ["INTENCOES_TABLE"],
            tabela_transacoes=os.environ["TRANSACOES_TABLE"],
            tabela_catalogo=os.environ["CATALOGO_TABLE"],
            usuario_id=usuario_id,
            intencao_id=argumentos.get("intencao_id"),
            metodo_pagamento=argumentos.get("metodo_pagamento"),
        )

    except Exception:
        logger.exception("Falha ao executar realizar_compra.")
        return criar_erro("ERRO_INTERNO")