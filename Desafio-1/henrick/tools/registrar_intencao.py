import os
import secrets
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal

import boto3

dynamodb = boto3.resource("dynamodb")
tabela_produtos = dynamodb.Table(os.environ["TABELA_PRODUTOS"])
tabela_intencoes = dynamodb.Table(os.environ["TABELA_INTENCOES"])
TTL_SEGUNDOS = int(os.environ.get("INTENCAO_TTL_SEGUNDOS", "300"))


def _erro(codigo, mensagem):
    return {"erro": codigo, "mensagem": mensagem}


def handler(event, context):
    event = event or {}
    usuario_id = event.get("usuario_id")
    produto_id = event.get("produto_id")
    quantidade = event.get("quantidade")

    # Sem usuario_id, a chamada nao veio do agente: recusa.
    if not usuario_id:
        return _erro("NAO_AUTENTICADO", "Usuario nao identificado.")

    if not isinstance(quantidade, int) or isinstance(quantidade, bool) or quantidade <= 0:
        return _erro("QUANTIDADE_INVALIDA", "A quantidade deve ser um numero inteiro maior que zero.")

    produto = None
    if produto_id:
        produto = tabela_produtos.get_item(Key={"produto_id": produto_id}).get("Item")

    if not produto:
        return _erro(
            "PRODUTO_INVALIDO",
            f"O produto {produto_id} nao existe no catalogo. Use listar_catalogo para ver os ids validos.",
        )

    if produto["estoque"] < quantidade:
        return _erro(
            "ESTOQUE_INSUFICIENTE",
            f"{produto['nome']} tem apenas {produto['estoque']} unidade(s) em estoque, e foram pedidas {quantidade}.",
        )

    # O valor e calculado AQUI, a partir do preco da tabela. O modelo nunca informa valor.
    valor_total = (produto["preco"] * quantidade).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    agora = datetime.now(timezone.utc)
    intencao = {
        "intencao_id": f"int_{secrets.token_hex(3)}",
        "usuario_id": usuario_id,
        "produto_id": produto["produto_id"],
        "produto_nome": produto["nome"],
        "quantidade": quantidade,
        "valor_total": valor_total,
        "moeda": produto["moeda"],
        "status": "pendente",
        "criada_em": agora.isoformat(),
        "expira_em": (agora + timedelta(seconds=TTL_SEGUNDOS)).isoformat(),
    }

    # So grava se o id ainda nao existir (protege contra colisao de id aleatorio).
    tabela_intencoes.put_item(
        Item=intencao,
        ConditionExpression="attribute_not_exists(intencao_id)",
    )

    return {
        "intencao_id": intencao["intencao_id"],
        "produto_id": intencao["produto_id"],
        "produto_nome": intencao["produto_nome"],
        "quantidade": quantidade,
        "valor_total": float(valor_total),
        "moeda": intencao["moeda"],
        "status": "pendente",
        "criada_em": intencao["criada_em"],
        "expira_em": intencao["expira_em"],
    }