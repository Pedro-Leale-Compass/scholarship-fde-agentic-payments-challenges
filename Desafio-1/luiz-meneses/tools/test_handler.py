"""Testes das regras de negócio com DynamoDB simulado (moto). Rodar: pytest tools/"""
import os
from datetime import datetime, timedelta, timezone

import boto3
import pytest
from moto import mock_aws

os.environ.update(
    AWS_DEFAULT_REGION="us-east-1",
    AWS_ACCESS_KEY_ID="testing",
    AWS_SECRET_ACCESS_KEY="testing",
    TABELA_USUARIOS="usuarios",
    TABELA_CATALOGO="catalogo",
    TABELA_INTENCOES="intencoes",
    TABELA_TRANSACOES="transacoes",
    LIMITE_PADRAO_CENTAVOS="200000",
)


@pytest.fixture
def h():
    with mock_aws():
        ddb = boto3.client("dynamodb")
        for nome, chave in [("usuarios", "usuario_id"), ("catalogo", "produto_id"),
                            ("intencoes", "intencao_id"), ("transacoes", "transacao_id")]:
            ddb.create_table(TableName=nome, BillingMode="PAY_PER_REQUEST",
                             KeySchema=[{"AttributeName": chave, "KeyType": "HASH"}],
                             AttributeDefinitions=[{"AttributeName": chave, "AttributeType": "S"}])
        for pid, nome, preco, est in [("prod_001", "Mouse Gamer", 12990, 15), ("prod_004", "Notebook", 459990, 3)]:
            ddb.put_item(TableName="catalogo", Item={
                "produto_id": {"S": pid}, "nome": {"S": nome}, "categoria": {"S": "x"},
                "preco_centavos": {"N": str(preco)}, "moeda": {"S": "BRL"}, "estoque": {"N": str(est)}})
        import importlib
        import handler
        importlib.reload(handler)
        yield handler


def call(h, tool, user="u1", **args):
    return h.handler({"tool": tool, "usuario_id": user, "args": args}, None)


def test_compra_pix_e_cartao(h):
    assert len(call(h, "listar_catalogo")["produtos"]) == 2
    i = call(h, "registrar_intencao", produto_id="prod_001", quantidade=2)
    assert i["valor_total"] == 259.80
    r = call(h, "realizar_compra", intencao_id=i["intencao_id"], metodo_pagamento="pix")
    assert r["status"] == "aprovado" and r["limite_restante"] == 1740.20
    i2 = call(h, "registrar_intencao", produto_id="prod_001", quantidade=1)
    assert call(h, "realizar_compra", intencao_id=i2["intencao_id"], metodo_pagamento="cartao")["status"] == "aprovado"


def test_duplicidade(h):
    i = call(h, "registrar_intencao", produto_id="prod_001", quantidade=1)
    call(h, "realizar_compra", intencao_id=i["intencao_id"], metodo_pagamento="pix")
    r = call(h, "realizar_compra", intencao_id=i["intencao_id"], metodo_pagamento="pix")
    assert r["erro"] == "INTENCAO_JA_PAGA"


def test_limite_excedido(h):
    i = call(h, "registrar_intencao", produto_id="prod_004", quantidade=1)
    assert call(h, "realizar_compra", intencao_id=i["intencao_id"], metodo_pagamento="pix")["erro"] == "LIMITE_EXCEDIDO"


def test_intencao_invalida_e_de_outro_usuario(h):
    assert call(h, "realizar_compra", intencao_id="int_falsa", metodo_pagamento="pix")["erro"] == "INTENCAO_INVALIDA"
    i = call(h, "registrar_intencao", produto_id="prod_001", quantidade=1)
    r = call(h, "realizar_compra", user="intruso", intencao_id=i["intencao_id"], metodo_pagamento="pix")
    assert r["erro"] == "INTENCAO_INVALIDA"


def test_metodo_invalido(h):
    i = call(h, "registrar_intencao", produto_id="prod_001", quantidade=1)
    assert call(h, "realizar_compra", intencao_id=i["intencao_id"], metodo_pagamento="boleto")["erro"] == "METODO_INVALIDO"


def test_intencao_expirada(h):
    i = call(h, "registrar_intencao", produto_id="prod_001", quantidade=1)
    passado = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    boto3.client("dynamodb").update_item(TableName="intencoes", Key={"intencao_id": {"S": i["intencao_id"]}},
                                         UpdateExpression="SET expira_em = :e",
                                         ExpressionAttributeValues={":e": {"S": passado}})
    assert call(h, "realizar_compra", intencao_id=i["intencao_id"], metodo_pagamento="pix")["erro"] == "INTENCAO_EXPIRADA"


def test_usuario_nao_vem_dos_args(h):
    r = h.handler({"tool": "listar_catalogo", "usuario_id": "u1", "args": {"usuario_id": "outro"}}, None)
    assert r["erro"] == "ARGUMENTOS_INVALIDOS"
