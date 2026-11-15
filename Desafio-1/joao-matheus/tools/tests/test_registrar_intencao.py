from registrar_intencao import handler

def test_registrar_intencao_calcula_valor_no_backend(mock_dynamodb):
    # prod_003 custa 30.00 -> 2 unidades = 60.00
    evento = {
        "usuario_id": "user_123",
        "argumentos": {
            "produto_id": "prod_003",
            "quantidade": 2,
        },
    }
    resp = handler(evento)

    assert resp["status"] == "pendente"
    assert resp["produto_id"] == "prod_003"
    assert resp["quantidade"] == 2
    assert resp["valor_total"] == 60.00
    assert resp["moeda"] == "BRL"
    assert "intencao_id" in resp
    assert resp["intencao_id"].startswith("int_")
    assert "expira_em" in resp

    # Conferir se persistiu no DynamoDB com usuario_id correto
    tab = mock_dynamodb.Table("teste-intencoes")
    item = tab.get_item(Key={"intencao_id": resp["intencao_id"]})["Item"]
    assert item["usuario_id"] == "user_123"
    assert item["status"] == "pendente"
    assert item["valor_total"] == 60.00

def test_registrar_intencao_produto_inexistente(mock_dynamodb):
    evento = {
        "usuario_id": "user_123",
        "argumentos": {
            "produto_id": "prod_999",
            "quantidade": 1,
        },
    }
    resp = handler(evento)
    assert resp["status"] == "recusado"
    assert resp["codigo"] == "PRODUTO_NAO_ENCONTRADO"

def test_registrar_intencao_quantidade_invalida(mock_dynamodb):
    casos_invalidos = [0, -1, 1.5, "2", True, False, 101]
    for qtd in casos_invalidos:
        evento = {
            "usuario_id": "user_123",
            "argumentos": {
                "produto_id": "prod_001",
                "quantidade": qtd,
            },
        }
        resp = handler(evento)
        assert resp["status"] == "recusado"
        assert resp["codigo"] == "QUANTIDADE_INVALIDA"

def test_registrar_intencao_sem_usuario_autenticado(mock_dynamodb):
    evento = {
        "argumentos": {
            "produto_id": "prod_001",
            "quantidade": 1,
        },
    }
    resp = handler(evento)
    assert resp["status"] == "recusado"
    assert resp["codigo"] == "USUARIO_NAO_AUTENTICADO"
