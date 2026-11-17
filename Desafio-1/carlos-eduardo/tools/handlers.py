import json
import logging
import os
import uuid
from datetime import datetime, timedelta, timezone

import boto3
from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = os.environ.get("AWS_REGION", "us-east-1")
DEFAULT_SPENDING_LIMIT_CENTS = 200000
dynamodb = boto3.resource("dynamodb", region_name=REGION)
client = boto3.client("dynamodb", region_name=REGION)


def _error(code, message):
    return {"status": "recusado", "erro": code, "mensagem": message}


def _now():
    return datetime.now(timezone.utc)


def _list_catalog(arguments):
    category = arguments.get("categoria")
    table = dynamodb.Table(os.environ["PRODUCTS_TABLE"])
    products = []
    last_key = None
    while True:
        params = {
            "FilterExpression": Attr("stock").gt(0),
        }
        if category:
            params["FilterExpression"] &= Attr("category").eq(category)
        if last_key:
            params["ExclusiveStartKey"] = last_key
        page = table.scan(**params)
        products.extend(page.get("Items", []))
        last_key = page.get("LastEvaluatedKey")
        if not last_key:
            break
    return {
        "produtos": [
            {
                "id": item["product_id"],
                "nome": item["name"],
                "preco": int(item["price_cents"]) / 100,
                "moeda": item.get("currency", "BRL"),
                "estoque": int(item["stock"]),
            }
            for item in products
        ]
    }


def _register_intent(arguments, user_id, chat_id):
    quantity = arguments.get("quantidade")
    if isinstance(quantity, bool) or not isinstance(quantity, int) or quantity <= 0:
        return _error("QUANTIDADE_INVALIDA", "A quantidade deve ser um inteiro maior que zero.")

    product_id = arguments.get("produto_id")
    if not isinstance(product_id, str) or not product_id:
        return _error("PRODUTO_INVALIDO", "Produto não encontrado.")

    products = dynamodb.Table(os.environ["PRODUCTS_TABLE"])
    product = products.get_item(Key={"product_id": product_id}).get("Item")
    if not product:
        return _error("PRODUTO_INVALIDO", "Produto não encontrado.")
    if quantity > int(product["stock"]):
        return _error("ESTOQUE_INSUFICIENTE", "Estoque insuficiente para a quantidade.")

    now = _now()
    expires_at = now + timedelta(minutes=30)
    intent_id = f"int_{uuid.uuid4().hex[:12]}"
    total_cents = int(product["price_cents"]) * quantity
    intent = {
        "intent_id": intent_id,
        "user_id": user_id,
        "chat_id": chat_id,
        "product_id": product_id,
        "product_name": product["name"],
        "quantity": quantity,
        "total_cents": total_cents,
        "currency": product.get("currency", "BRL"),
        "status": "pendente",
        "expires_at": expires_at.isoformat(),
        "created_at": now.isoformat(),
    }
    dynamodb.Table(os.environ["INTENTS_TABLE"]).put_item(
        Item=intent,
        ConditionExpression="attribute_not_exists(intent_id)",
    )
    return {
        "intencao_id": intent_id,
        "produto_id": product_id,
        "quantidade": quantity,
        "valor_total": total_cents / 100,
        "moeda": intent["currency"],
        "status": "pendente",
        "expira_em": intent["expires_at"],
    }


def _normalize_method(raw_method):
    if not isinstance(raw_method, str):
        return None
    cleaned = (
        raw_method.strip()
        .lower()
        .replace("ã", "a")
        .replace("á", "a")
        .replace("é", "e")
        .replace("í", "i")
    )
    has_pix = "pix" in cleaned
    has_card = any(token in cleaned for token in ("cartao", "credito", "debito", "card"))
    if has_pix and not has_card:
        return "pix"
    if has_card and not has_pix:
        return "cartao"
    return None


def _purchase(arguments, user_id, chat_id, confirmed_method=None):
    intent_id = arguments.get("intencao_id")
    method = _normalize_method(arguments.get("metodo_pagamento"))
    if not isinstance(intent_id, str) or not intent_id:
        return _error("INTENCAO_INVALIDA", "A intenção informada não é válida.")
    if method not in ("cartao", "pix"):
        return _error("METODO_INVALIDO", "O método deve ser Pix ou cartão.")
    if confirmed_method in ("cartao", "pix") and method != confirmed_method:
        return _error(
            "METODO_INVALIDO",
            "O método de pagamento informado diverge da confirmação na mensagem.",
        )

    intents = dynamodb.Table(os.environ["INTENTS_TABLE"])
    intent = intents.get_item(Key={"intent_id": intent_id}, ConsistentRead=True).get("Item")
    if not intent or intent.get("user_id") != user_id or intent.get("chat_id") != chat_id:
        return _error("INTENCAO_INVALIDA", "A intenção não pertence a este usuário ou conversa.")
    if intent.get("status") == "paga":
        return _error("INTENCAO_JA_PAGA", "Essa intenção já foi utilizada.")
    if intent.get("status") != "pendente":
        return _error("INTENCAO_INVALIDA", "A intenção informada não está pendente.")
    now = _now()
    if now >= datetime.fromisoformat(intent["expires_at"]):
        return _error("INTENCAO_EXPIRADA", "Essa intenção de compra expirou.")

    users = dynamodb.Table(os.environ["USERS_TABLE"])
    total_cents = int(intent["total_cents"])
    transaction_id = f"tx_{uuid.uuid4().hex[:12]}"
    timestamp = now.isoformat()
    for attempt in range(3):
        user = users.get_item(Key={"user_id": user_id}, ConsistentRead=True).get("Item")
        if not user:
            user = {
                "user_id": user_id,
                "spending_limit_cents": DEFAULT_SPENDING_LIMIT_CENTS,
                "spent_cents": 0,
            }
            try:
                users.put_item(
                    Item=user,
                    ConditionExpression="attribute_not_exists(user_id)",
                )
            except ClientError as error:
                if error.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                    raise
                user = users.get_item(Key={"user_id": user_id}, ConsistentRead=True).get("Item")
        previous_spent = int(user["spent_cents"])
        next_spent = previous_spent + total_cents
        available = int(user["spending_limit_cents"]) - previous_spent
        if total_cents > available:
            return _error("LIMITE_EXCEDIDO", "A compra ultrapassa o limite disponível.")
        try:
            client.transact_write_items(
                TransactItems=[
                    {
                        "Update": {
                            "TableName": os.environ["PRODUCTS_TABLE"],
                            "Key": {"product_id": {"S": intent["product_id"]}},
                            "UpdateExpression": "SET #stock = #stock - :quantity",
                            "ConditionExpression": "attribute_exists(product_id) AND #stock >= :quantity",
                            "ExpressionAttributeNames": {"#stock": "stock"},
                            "ExpressionAttributeValues": {":quantity": {"N": str(intent["quantity"])}},
                        }
                    },
                    {
                        "Update": {
                            "TableName": os.environ["USERS_TABLE"],
                            "Key": {"user_id": {"S": user_id}},
                            "UpdateExpression": "SET spent_cents = :next_spent",
                            "ConditionExpression": (
                                "spent_cents = :previous_spent "
                                "AND spending_limit_cents >= :next_spent"
                            ),
                            "ExpressionAttributeValues": {
                                ":previous_spent": {"N": str(previous_spent)},
                                ":next_spent": {"N": str(next_spent)},
                            },
                        }
                    },
                    {
                        "Update": {
                            "TableName": os.environ["INTENTS_TABLE"],
                            "Key": {"intent_id": {"S": intent_id}},
                            "UpdateExpression": "SET #status = :paid",
                            "ConditionExpression": (
                                "user_id = :user_id AND chat_id = :chat_id AND #status = :pending "
                                "AND expires_at > :now"
                            ),
                            "ExpressionAttributeNames": {"#status": "status"},
                            "ExpressionAttributeValues": {
                                ":paid": {"S": "paga"},
                                ":pending": {"S": "pendente"},
                                ":user_id": {"S": user_id},
                                ":chat_id": {"S": chat_id},
                                ":now": {"S": _now().isoformat()},
                            },
                        }
                    },
                    {
                        "Put": {
                            "TableName": os.environ["TRANSACTIONS_TABLE"],
                            "Item": {
                                "user_id": {"S": user_id},
                                "transaction_key": {"S": f"{timestamp}#{transaction_id}"},
                                "transaction_id": {"S": transaction_id},
                                "intent_id": {"S": intent_id},
                                "product_id": {"S": intent["product_id"]},
                                "product_name": {"S": intent["product_name"]},
                                "quantity": {"N": str(intent["quantity"])},
                                "amount_cents": {"N": str(total_cents)},
                                "currency": {"S": intent.get("currency", "BRL")},
                                "payment_method": {"S": method},
                                "created_at": {"S": timestamp},
                            },
                            "ConditionExpression": "attribute_not_exists(transaction_key)",
                        }
                    },
                ]
            )
            break
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") != "TransactionCanceledException":
                raise
            latest_intent = intents.get_item(
                Key={"intent_id": intent_id}, ConsistentRead=True
            ).get("Item")
            if latest_intent and latest_intent.get("status") == "paga":
                return _error("INTENCAO_JA_PAGA", "Essa intenção já foi utilizada.")
            if latest_intent and _now() >= datetime.fromisoformat(latest_intent["expires_at"]):
                return _error("INTENCAO_EXPIRADA", "Essa intenção de compra expirou.")
            latest_user = users.get_item(
                Key={"user_id": user_id}, ConsistentRead=True
            ).get("Item")
            if latest_user and total_cents > (
                int(latest_user["spending_limit_cents"]) - int(latest_user["spent_cents"])
            ):
                return _error("LIMITE_EXCEDIDO", "A compra ultrapassa o limite disponível.")
            latest_product = dynamodb.Table(os.environ["PRODUCTS_TABLE"]).get_item(
                Key={"product_id": intent["product_id"]}, ConsistentRead=True
            ).get("Item")
            if latest_product and int(latest_product["stock"]) < int(intent["quantity"]):
                return _error("ESTOQUE_INSUFICIENTE", "Estoque insuficiente para a quantidade.")
            if attempt == 2:
                raise
    else:
        raise RuntimeError("Não foi possível confirmar a transação.")

    return {
        "status": "aprovado",
        "transacao_id": transaction_id,
        "intencao_id": intent_id,
        "valor": total_cents / 100,
        "metodo_pagamento": method,
        "limite_restante": (available - total_cents) / 100,
        "data": timestamp,
    }


def _purchase_history(arguments, user_id):
    limit = arguments.get("limite", 3)
    if isinstance(limit, bool):
        return _error("LIMITE_INVALIDO", "O limite informado não é um número válido.")
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        return _error("LIMITE_INVALIDO", "O limite informado não é um número válido.")
    limit = 3 if limit <= 0 else min(limit, 10)

    page = dynamodb.Table(os.environ["TRANSACTIONS_TABLE"]).query(
        KeyConditionExpression=Key("user_id").eq(user_id),
        ScanIndexForward=False,
        Limit=limit,
    )
    return {
        "compras": [
            {
                "id": item["transaction_id"],
                "produto": item["product_name"],
                "produto_id": item["product_id"],
                "quantidade": int(item["quantity"]),
                "valor": int(item["amount_cents"]) / 100,
                "moeda": item.get("currency", "BRL"),
                "metodo_pagamento": item["payment_method"],
                "data": item["created_at"],
            }
            for item in page.get("Items", [])
        ]
    }


def lambda_handler(event, context):
    tool_name = os.environ["TOOL_NAME"]
    arguments = event.get("arguments", {})
    user_id = event.get("user_id")
    chat_id = event.get("chat_id")
    if not isinstance(arguments, dict) or not isinstance(user_id, str) or not user_id:
        return _error("REQUISICAO_INVALIDA", "Não foi possível validar a solicitação.")

    try:
        if tool_name == "listar_catalogo":
            return _list_catalog(arguments)
        if tool_name == "registrar_intencao":
            if not isinstance(chat_id, str) or not chat_id:
                return _error("REQUISICAO_INVALIDA", "A conversa não pôde ser validada.")
            return _register_intent(arguments, user_id, chat_id)
        if tool_name == "realizar_compra":
            if not isinstance(chat_id, str) or not chat_id:
                return _error("REQUISICAO_INVALIDA", "A conversa não pôde ser validada.")
            return _purchase(
                arguments,
                user_id,
                chat_id,
                event.get("confirmed_method"),
            )
        if tool_name == "consultar_historico_compras":
            return _purchase_history(arguments, user_id)
        logger.error("Unknown tool configured on Lambda: %s", tool_name)
        return _error("FERRAMENTA_INDISPONIVEL", "A ferramenta solicitada não está disponível.")
    except ClientError:
        logger.exception("DynamoDB operation failed for tool %s", tool_name)
        return _error("ERRO_INTERNO", "Não foi possível concluir a operação. Tente novamente.")
    except (KeyError, TypeError, ValueError):
        logger.exception("Invalid tool event for %s", tool_name)
        return _error("REQUISICAO_INVALIDA", "Não foi possível processar os argumentos da ferramenta.")
    except Exception:
        logger.exception("Unexpected error in tool %s", tool_name)
        return _error("ERRO_INTERNO", "Não foi possível concluir a operação. Tente novamente.")
