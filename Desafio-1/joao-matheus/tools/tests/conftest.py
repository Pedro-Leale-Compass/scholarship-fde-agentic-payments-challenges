import os
import pytest
import boto3
from moto import mock_aws
from decimal import Decimal

@pytest.fixture(autouse=True)
def ambiente_aws(monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_SECURITY_TOKEN", "testing")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setenv("TABELA_PRODUTOS", "teste-produtos")
    monkeypatch.setenv("TABELA_USUARIOS", "teste-usuarios")
    monkeypatch.setenv("TABELA_INTENCOES", "teste-intencoes")
    monkeypatch.setenv("TABELA_TRANSACOES", "teste-transacoes")
    monkeypatch.setenv("MINUTOS_EXPIRACAO", "10")
    monkeypatch.setenv("LIMITE_PADRAO", "500.00")

@pytest.fixture
def mock_dynamodb(ambiente_aws):
    with mock_aws():
        dynamodb = boto3.resource("dynamodb", region_name="us-east-1")

        # Tabela produtos
        tab_produtos = dynamodb.create_table(
            TableName="teste-produtos",
            KeySchema=[{"AttributeName": "produto_id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "produto_id", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )

        # Tabela usuarios
        dynamodb.create_table(
            TableName="teste-usuarios",
            KeySchema=[{"AttributeName": "usuario_id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "usuario_id", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )

        # Tabela intencoes
        dynamodb.create_table(
            TableName="teste-intencoes",
            KeySchema=[{"AttributeName": "intencao_id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "intencao_id", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )

        # Tabela transacoes
        dynamodb.create_table(
            TableName="teste-transacoes",
            KeySchema=[{"AttributeName": "transacao_id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "transacao_id", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )

        # Seed do catálogo
        itens_catalogo = [
            {
                "produto_id": "prod_001",
                "nome": "Fone Bluetooth",
                "preco": Decimal("249.90"),
                "descricao": "Fone de ouvido sem fio bluetooth com cancelamento de ruído",
                "moeda": "BRL",
            },
            {
                "produto_id": "prod_002",
                "nome": "Carregador Turbo",
                "preco": Decimal("80.00"),
                "descricao": "Carregador de tomada turbo 30W USB-C",
                "moeda": "BRL",
            },
            {
                "produto_id": "prod_003",
                "nome": "Cabo USB",
                "preco": Decimal("30.00"),
                "descricao": "Cabo USB para USB-C reforçado 1m",
                "moeda": "BRL",
            },
        ]
        for item in itens_catalogo:
            tab_produtos.put_item(Item=item)

        yield dynamodb
