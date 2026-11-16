import os
import secrets
from datetime import datetime, timezone
from decimal import Decimal

import boto3

dynamodb = boto3.resource("dynamodb")
cliente = dynamodb.meta.client

NOME_INTENCOES = os.environ["TABELA_INTENCOES"]
NOME_USUARIOS = os.environ["TABELA_USUARIOS"]
NOME_PRODUTOS = os.environ["TABELA_PRODUTOS"]

tabela_intencoes = dynamodb.Table(NOME_INTENCOES)
tabela_usuarios = dynamodb.Table(NOME_USUARIOS)

METODOS_ACEITOS = {"cartao", "pix"}


def _recusar(erro, mensagem):
    return {"status": "recusado", "erro": erro, "mensagem": mensagem}


def _limite_de(usuario_id):
    usuario = tabela_usuarios.get_item(
        Key={"usuario_id": usuario_id}, ConsistentRead=True
    ).get("Item")
    return usuario["limite_restante"] if usuario else Decimal("0")


def handler(event, context):
    event = event or {}
    usuario_id = event.get("usuario_id")
    intencao_id = event.get("intencao_id") or ""
    metodo = event.get("metodo_pagamento")

    if not usuario_id:
        return _recusar("NAO_AUTENTICADO", "Usuario nao identificado.")

    intencao = tabela_intencoes.get_item(
        Key={"intencao_id": intencao_id}, ConsistentRead=True
    ).get("Item")

    # 1. Nao existe OU e de outro usuario: mesma resposta, para nao revelar que existe.
    if not intencao or intencao["usuario_id"] != usuario_id:
        return _recusar(
            "INTENCAO_INVALIDA",
            f"A intencao {intencao_id} nao existe ou nao pertence a este usuario.",
        )

    # 2. Ja foi paga.
    if intencao["status"] == "pago":
        return _recusar(
            "INTENCAO_JA_PAGA",
            f"A intencao {intencao_id} ja foi paga e nao pode ser cobrada de novo.",
        )

    # 3. Passou do prazo.
    agora = datetime.now(timezone.utc)
    if agora > datetime.fromisoformat(intencao["expira_em"]):
        return _recusar(
            "INTENCAO_EXPIRADA",
            f"A intencao {intencao_id} expirou em {intencao['expira_em']}. Registre uma nova intencao.",
        )

    # 4. Metodo de pagamento.
    if metodo not in METODOS_ACEITOS:
        return _recusar("METODO_INVALIDO", f'Metodo "{metodo}" nao e aceito. Use cartao ou pix.')

    # 5. Limite. O valor vem da intencao salva, nunca do modelo.
    valor = intencao["valor_total"]
    limite = _limite_de(usuario_id)
    if valor > limite:
        return _recusar(
            "LIMITE_EXCEDIDO",
            f"O valor de R$ {valor:.2f} ultrapassa o limite disponivel de R$ {limite:.2f}.",
        )

    # 6. Cobra: tres escritas condicionais, todas ou nenhuma.
    transacao_id = f"tx_{secrets.token_hex(3)}"
    pago_em = agora.isoformat()

    try:
        cliente.transact_write_items(
            TransactItems=[
                {
                    "Update": {
                        "TableName": NOME_INTENCOES,
                        "Key": {"intencao_id": intencao_id},
                        "UpdateExpression": "SET #st = :pago, transacao_id = :tx, metodo_pagamento = :metodo, pago_em = :agora",
                        "ConditionExpression": "#st = :pendente AND usuario_id = :usuario AND expira_em > :agora",
                        "ExpressionAttributeNames": {"#st": "status"},
                        "ExpressionAttributeValues": {
                            ":pago": "pago",
                            ":pendente": "pendente",
                            ":tx": transacao_id,
                            ":metodo": metodo,
                            ":agora": pago_em,
                            ":usuario": usuario_id,
                        },
                    }
                },
                {
                    "Update": {
                        "TableName": NOME_USUARIOS,
                        "Key": {"usuario_id": usuario_id},
                        "UpdateExpression": "SET limite_restante = limite_restante - :valor",
                        "ConditionExpression": "limite_restante >= :valor",
                        "ExpressionAttributeValues": {":valor": valor},
                    }
                },
                {
                    "Update": {
                        "TableName": NOME_PRODUTOS,
                        "Key": {"produto_id": intencao["produto_id"]},
                        "UpdateExpression": "SET estoque = estoque - :qtd",
                        "ConditionExpression": "estoque >= :qtd",
                        "ExpressionAttributeValues": {":qtd": intencao["quantidade"]},
                    }
                },
            ]
        )
    except cliente.exceptions.TransactionCanceledException as erro:
        motivos = erro.response.get("CancellationReasons", [])
        falhou = [m.get("Code") == "ConditionalCheckFailed" for m in motivos]
        if len(falhou) > 0 and falhou[0]:
            return _recusar("INTENCAO_JA_PAGA", f"A intencao {intencao_id} ja foi paga ou expirou.")
        if len(falhou) > 1 and falhou[1]:
            return _recusar("LIMITE_EXCEDIDO", "O limite disponivel nao cobre esta compra.")
        if len(falhou) > 2 and falhou[2]:
            return _recusar("ESTOQUE_INSUFICIENTE", "O produto nao tem mais estoque suficiente.")
        raise

    return {
        "status": "aprovado",
        "transacao_id": transacao_id,
        "intencao_id": intencao_id,
        "produto_nome": intencao["produto_nome"],
        "quantidade": int(intencao["quantidade"]),
        "valor_debitado": float(valor),
        "metodo_pagamento": metodo,
        "limite_restante": float(_limite_de(usuario_id)),
        "criada_em": pago_em,
    }