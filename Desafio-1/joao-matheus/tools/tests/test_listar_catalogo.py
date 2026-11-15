from listar_catalogo import handler

def test_listar_catalogo_retorna_produtos_ordenados(mock_dynamodb):
    evento = {"usuario_id": "user_123", "argumentos": {}}
    resp = handler(evento)

    assert "produtos" in resp
    produtos = resp["produtos"]
    assert len(produtos) == 3

    assert produtos[0]["id"] == "prod_001"
    assert produtos[0]["nome"] == "Fone Bluetooth"
    assert produtos[0]["preco"] == 249.90
    assert produtos[0]["moeda"] == "BRL"

    assert produtos[1]["id"] == "prod_002"
    assert produtos[1]["preco"] == 80.00

    assert produtos[2]["id"] == "prod_003"
    assert produtos[2]["preco"] == 30.00

def test_listar_catalogo_sem_usuario_autenticado(mock_dynamodb):
    evento = {"argumentos": {}}
    resp = handler(evento)
    assert resp["status"] == "recusado"
    assert resp["codigo"] == "USUARIO_NAO_AUTENTICADO"
