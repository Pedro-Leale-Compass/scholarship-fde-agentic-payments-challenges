import os
from decimal import Decimal

import boto3

tabela_produtos = boto3.resource("dynamodb").Table(os.environ["TABELA_PRODUTOS"])


def _numero(valor):
    """O DynamoDB devolve numeros como Decimal; aqui viram int ou float comuns."""
    if isinstance(valor, Decimal):
        return int(valor) if valor % 1 == 0 else float(valor)
    return valor


def handler(event, context):
    categoria = (event or {}).get("categoria")

    itens = tabela_produtos.scan()["Items"]

    produtos = [
        {
            "id": item["produto_id"],
            "nome": item["nome"],
            "descricao": item["descricao"],
            "categoria": item["categoria"],
            "preco": _numero(item["preco"]),
            "moeda": item["moeda"],
            "estoque": _numero(item["estoque"]),
        }
        for item in itens
        if not categoria or item["categoria"] == categoria
    ]

    produtos.sort(key=lambda p: p["id"])
    return {"produtos": produtos}