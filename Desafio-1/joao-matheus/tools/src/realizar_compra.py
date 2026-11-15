import os
from decimal import Decimal
from botocore.exceptions import ClientError
from comum import tabela, obter_dynamodb_client, extrair_evento, recusa, agora_utc, tratar_erros

def mapear_erro_cancelamento(reasons: list, tab_intencoes, intencao_id: str, agora_epoch: int) -> dict:
    # i=0: Falha na condição da intenção
    if len(reasons) > 0 and reasons[0].get("Code") == "ConditionalCheckFailed":
        resp = tab_intencoes.get_item(Key={"intencao_id": intencao_id}, ConsistentRead=True)
        intencao = resp.get("Item", {})
        if intencao.get("status") == "paga":
            return recusa("INTENCAO_JA_PAGA", "Esta intenção de compra já foi paga anteriormente.")
        if intencao.get("expira_em_epoch", 0) <= agora_epoch:
            return recusa("INTENCAO_EXPIRADA", "Esta intenção de compra expirou.")
        return recusa("INTENCAO_INVALIDA", "Intenção de compra inválida, inexistente ou não pertence ao usuário informado.")

    # i=1: Falha na condição do usuário (saldo/limite insuficiente)
    if len(reasons) > 1 and reasons[1].get("Code") == "ConditionalCheckFailed":
        return recusa("LIMITE_EXCEDIDO", "Limite de crédito insuficiente para realizar esta compra.")

    # i=2: Falha na condição da transação (transacao_id já existe => intenção já paga)
    if len(reasons) > 2 and reasons[2].get("Code") == "ConditionalCheckFailed":
        return recusa("INTENCAO_JA_PAGA", "Esta intenção de compra já foi paga anteriormente.")

    return recusa("ERRO_INTERNO", "Não foi possível processar o pagamento no momento.")

@tratar_erros("realizar_compra")
def handler(event, context=None):
    usuario_id, argumentos = extrair_evento(event)

    # 1. Validação do método de pagamento
    metodo = argumentos.get("metodo_pagamento")
    if not metodo or metodo not in ["cartao", "pix"]:
        return recusa("METODO_INVALIDO", "Método de pagamento inválido. Use 'cartao' ou 'pix'.")

    intencao_id = argumentos.get("intencao_id")
    if not intencao_id or not isinstance(intencao_id, str) or not intencao_id.strip():
        return recusa("INTENCAO_INVALIDA", "Intenção de compra inválida, inexistente ou não pertence ao usuário informado.")
    intencao_id = intencao_id.strip()

    tab_intencoes = tabela("TABELA_INTENCOES")
    tab_usuarios = tabela("TABELA_USUARIOS")

    # 2. Leitura consistente da intenção
    resp_int = tab_intencoes.get_item(Key={"intencao_id": intencao_id}, ConsistentRead=True)
    intencao = resp_int.get("Item")
    if not intencao or intencao.get("usuario_id") != usuario_id:
        return recusa("INTENCAO_INVALIDA", "Intenção de compra inválida, inexistente ou não pertence ao usuário informado.")

    # 3. Validação de status
    if intencao.get("status") == "paga":
        return recusa("INTENCAO_JA_PAGA", "Esta intenção de compra já foi paga anteriormente.")

    # 4. Validação de expiração
    agora = agora_utc()
    agora_epoch = int(agora.timestamp())
    agora_iso = agora.isoformat()
    if agora_epoch > int(intencao.get("expira_em_epoch", 0)):
        return recusa("INTENCAO_EXPIRADA", "Esta intenção de compra expirou.")

    valor_total = intencao.get("valor_total")
    if not isinstance(valor_total, Decimal):
        valor_total = Decimal(str(valor_total))

    # 5. Garantir existência do usuário (cria sob demanda com limite padrão se não existir)
    limite_padrao = Decimal(os.environ.get("LIMITE_PADRAO", "500.00"))
    resp_user = tab_usuarios.update_item(
        Key={"usuario_id": usuario_id},
        UpdateExpression="SET limite = if_not_exists(limite, :padrao), limite_restante = if_not_exists(limite_restante, :padrao), criado_em = if_not_exists(criado_em, :agora)",
        ExpressionAttributeValues={
            ":padrao": limite_padrao,
            ":agora": agora_iso,
        },
        ReturnValues="ALL_NEW"
    )
    usuario_item = resp_user.get("Attributes", {})
    limite_restante_pre = Decimal(str(usuario_item.get("limite_restante", 0)))
    if limite_restante_pre < valor_total:
        return recusa("LIMITE_EXCEDIDO", "Limite de crédito insuficiente para realizar esta compra.")

    # 6. Execução atômica com TransactWriteItems
    transacao_id = f"tx_{intencao_id}"
    nome_intencoes = os.environ["TABELA_INTENCOES"]
    nome_usuarios = os.environ["TABELA_USUARIOS"]
    nome_transacoes = os.environ["TABELA_TRANSACOES"]

    client = obter_dynamodb_client()

    transact_items = [
        {
            "Update": {
                "TableName": nome_intencoes,
                "Key": {"intencao_id": {"S": intencao_id}},
                "UpdateExpression": "SET #status = :paga, pago_em = :agora_iso, transacao_id = :tx_id",
                "ConditionExpression": "usuario_id = :uid AND #status = :pendente AND expira_em_epoch > :agora_epoch",
                "ExpressionAttributeNames": {"#status": "status"},
                "ExpressionAttributeValues": {
                    ":paga": {"S": "paga"},
                    ":agora_iso": {"S": agora_iso},
                    ":tx_id": {"S": transacao_id},
                    ":uid": {"S": usuario_id},
                    ":pendente": {"S": "pendente"},
                    ":agora_epoch": {"N": str(agora_epoch)},
                },
                "ReturnValuesOnConditionCheckFailure": "ALL_OLD",
            }
        },
        {
            "Update": {
                "TableName": nome_usuarios,
                "Key": {"usuario_id": {"S": usuario_id}},
                "UpdateExpression": "SET limite_restante = limite_restante - :valor",
                "ConditionExpression": "limite_restante >= :valor",
                "ExpressionAttributeValues": {
                    ":valor": {"N": str(valor_total)},
                },
                "ReturnValuesOnConditionCheckFailure": "ALL_OLD",
            }
        },
        {
            "Put": {
                "TableName": nome_transacoes,
                "Item": {
                    "transacao_id": {"S": transacao_id},
                    "intencao_id": {"S": intencao_id},
                    "usuario_id": {"S": usuario_id},
                    "metodo_pagamento": {"S": metodo},
                    "valor": {"N": str(valor_total)},
                    "status": {"S": "aprovado"},
                    "data": {"S": agora_iso},
                },
                "ConditionExpression": "attribute_not_exists(transacao_id)",
                "ReturnValuesOnConditionCheckFailure": "ALL_OLD",
            }
        },
    ]

    try:
        client.transact_write_items(TransactItems=transact_items)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code")
        if code == "TransactionCanceledException":
            reasons = exc.response.get("CancellationReasons", [])
            return mapear_erro_cancelamento(reasons, tab_intencoes, intencao_id, agora_epoch)
        if code == "TransactionConflictException":
            # Concorrência extrema: relê a intenção
            resp = tab_intencoes.get_item(Key={"intencao_id": intencao_id}, ConsistentRead=True)
            if resp.get("Item", {}).get("status") == "paga":
                return recusa("INTENCAO_JA_PAGA", "Esta intenção de compra já foi paga anteriormente.")
        raise exc

    # 7. Obter limite restante pós-transação de forma consistente
    resp_u = tab_usuarios.get_item(Key={"usuario_id": usuario_id}, ConsistentRead=True)
    limite_restante_pos = resp_u.get("Item", {}).get("limite_restante", 0)

    return {
        "status": "aprovado",
        "transacao_id": transacao_id,
        "limite_restante": float(limite_restante_pos),
        "data": agora_iso,
    }
