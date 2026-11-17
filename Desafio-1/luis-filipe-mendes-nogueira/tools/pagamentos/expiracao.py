def expirar_intencao(
    client,
    tabela_intencoes,
    tabela_catalogo,
    intencao,
    agora_epoch,
):
    intencao_id = intencao["intencao_id"]["S"]
    evento_id = intencao["evento_id"]["S"]
    quantidade = int(intencao["quantidade"]["N"])

    if quantidade <= 0:
        raise ValueError("Intenção armazenada com quantidade inválida.")

    try:
        client.transact_write_items(
            TransactItems=[
                {
                    "Update": {
                        "TableName": tabela_intencoes,
                        "Key": {
                            "intencao_id": {"S": intencao_id},
                        },
                        "UpdateExpression": "SET #status = :expirada",
                        "ConditionExpression": (
                            "#status = :pendente "
                            "AND expira_em_epoch <= :agora"
                        ),
                        "ExpressionAttributeNames": {
                            "#status": "status",
                        },
                        "ExpressionAttributeValues": {
                            ":expirada": {"S": "expirada"},
                            ":pendente": {"S": "pendente"},
                            ":agora": {"N": str(agora_epoch)},
                        },
                    }
                },
                {
                    "Update": {
                        "TableName": tabela_catalogo,
                        "Key": {
                            "evento_id": {"S": evento_id},
                        },
                        "UpdateExpression": (
                            "ADD vagas_restantes :quantidade"
                        ),
                        "ConditionExpression": (
                            "attribute_exists(evento_id)"
                        ),
                        "ExpressionAttributeValues": {
                            ":quantidade": {"N": str(quantidade)},
                        },
                    }
                },
            ]
        )

        return True

    except client.exceptions.TransactionCanceledException as erro:
        motivos = erro.response.get("CancellationReasons", [])

        # Outra operação pode ter pago ou expirado essa intenção.
        # Só ignoramos a falha esperada da primeira condição.
        condicao_da_intencao_falhou = (
            len(motivos) == 2
            and motivos[0].get("Code") == "ConditionalCheckFailed"
            and motivos[1].get("Code") in (None, "None")
        )

        if condicao_da_intencao_falhou:
            return False

        raise


def expirar_intencoes_vencidas(
    client,
    tabela_intencoes,
    tabela_catalogo,
    agora_epoch,
):
    total_expiradas = 0
    ultima_chave = None

    while True:
        parametros = {
            "TableName": tabela_intencoes,
            "IndexName": "por-status-expiracao",
            "KeyConditionExpression": (
                "#status = :pendente AND expira_em_epoch <= :agora"
            ),
            "ExpressionAttributeNames": {
                "#status": "status",
            },
            "ExpressionAttributeValues": {
                ":pendente": {"S": "pendente"},
                ":agora": {"N": str(agora_epoch)},
            },
        }

        if ultima_chave:
            parametros["ExclusiveStartKey"] = ultima_chave

        resposta = client.query(**parametros)

        for intencao in resposta.get("Items", []):
            expirou = expirar_intencao(
                client=client,
                tabela_intencoes=tabela_intencoes,
                tabela_catalogo=tabela_catalogo,
                intencao=intencao,
                agora_epoch=agora_epoch,
            )

            if expirou:
                total_expiradas += 1

        ultima_chave = resposta.get("LastEvaluatedKey")

        if not ultima_chave:
            return total_expiradas