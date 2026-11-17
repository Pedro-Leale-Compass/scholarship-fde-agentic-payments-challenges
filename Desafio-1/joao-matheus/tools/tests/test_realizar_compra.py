from decimal import Decimal
from datetime import datetime, timezone, timedelta
from registrar_intencao import handler as registrar_handler
from realizar_compra import handler as comprar_handler, mapear_erro_cancelamento
from comum import recusa

def test_compra_cartao_sucesso_com_usuario_novo(mock_dynamodb):
    # 1. Registrar intenção (cabo USB = 30.00)
    reg = registrar_handler({
        "usuario_id": "user_novo",
        "argumentos": {"produto_id": "prod_003", "quantidade": 1},
    })
    intencao_id = reg["intencao_id"]

    # 2. Realizar compra via cartao (limite padrão inicial = 500.00)
    resp = comprar_handler({
        "usuario_id": "user_novo",
        "argumentos": {
            "intencao_id": intencao_id,
            "metodo_pagamento": "cartao",
        },
    })

    assert resp["status"] == "aprovado"
    assert resp["transacao_id"] == f"tx_{intencao_id}"
    assert resp["limite_restante"] == 470.00
    assert "data" in resp

    # Conferir se intenção foi para status 'paga'
    tab_int = mock_dynamodb.Table("teste-intencoes")
    int_item = tab_int.get_item(Key={"intencao_id": intencao_id})["Item"]
    assert int_item["status"] == "paga"
    assert int_item["transacao_id"] == f"tx_{intencao_id}"

    # Conferir se transação foi criada
    tab_tx = mock_dynamodb.Table("teste-transacoes")
    tx_item = tab_tx.get_item(Key={"transacao_id": f"tx_{intencao_id}"})["Item"]
    assert tx_item["status"] == "aprovado"
    assert tx_item["valor"] == 30.00
    assert tx_item["metodo_pagamento"] == "cartao"

def test_compra_pix_sucesso(mock_dynamodb):
    reg = registrar_handler({
        "usuario_id": "user_pix",
        "argumentos": {"produto_id": "prod_002", "quantidade": 1}, # 80.00
    })
    intencao_id = reg["intencao_id"]

    resp = comprar_handler({
        "usuario_id": "user_pix",
        "argumentos": {
            "intencao_id": intencao_id,
            "metodo_pagamento": "pix",
        },
    })

    assert resp["status"] == "aprovado"
    assert resp["transacao_id"] == f"tx_{intencao_id}"
    assert resp["limite_restante"] == 420.00

def test_compra_metodo_invalido(mock_dynamodb):
    reg = registrar_handler({
        "usuario_id": "user_test",
        "argumentos": {"produto_id": "prod_003", "quantidade": 1},
    })
    resp = comprar_handler({
        "usuario_id": "user_test",
        "argumentos": {
            "intencao_id": reg["intencao_id"],
            "metodo_pagamento": "boleto",
        },
    })
    assert resp["status"] == "recusado"
    assert resp["codigo"] == "METODO_INVALIDO"

def test_compra_intencao_invalida_ou_de_outro_usuario(mock_dynamodb):
    # Inexistente
    resp = comprar_handler({
        "usuario_id": "user_test",
        "argumentos": {
            "intencao_id": "int_inexistente_123",
            "metodo_pagamento": "cartao",
        },
    })
    assert resp["status"] == "recusado"
    assert resp["codigo"] == "INTENCAO_INVALIDA"

    # Pertence a outro usuário
    reg = registrar_handler({
        "usuario_id": "user_dono",
        "argumentos": {"produto_id": "prod_003", "quantidade": 1},
    })
    resp_outro = comprar_handler({
        "usuario_id": "user_intruso",
        "argumentos": {
            "intencao_id": reg["intencao_id"],
            "metodo_pagamento": "cartao",
        },
    })
    assert resp_outro["status"] == "recusado"
    assert resp_outro["codigo"] == "INTENCAO_INVALIDA"

def test_compra_intencao_ja_paga_idempotencia(mock_dynamodb):
    reg = registrar_handler({
        "usuario_id": "user_idem",
        "argumentos": {"produto_id": "prod_003", "quantidade": 1}, # 30.00
    })
    intencao_id = reg["intencao_id"]

    # 1ª compra: OK
    resp1 = comprar_handler({
        "usuario_id": "user_idem",
        "argumentos": {"intencao_id": intencao_id, "metodo_pagamento": "cartao"},
    })
    assert resp1["status"] == "aprovado"
    assert resp1["limite_restante"] == 470.00

    # 2ª compra com o mesmo intencao_id: deve recusar e NÃO debitar de novo
    resp2 = comprar_handler({
        "usuario_id": "user_idem",
        "argumentos": {"intencao_id": intencao_id, "metodo_pagamento": "cartao"},
    })
    assert resp2["status"] == "recusado"
    assert resp2["codigo"] == "INTENCAO_JA_PAGA"

    # Limite deve continuar 470.00
    tab_usr = mock_dynamodb.Table("teste-usuarios")
    usuario = tab_usr.get_item(Key={"usuario_id": "user_idem"})["Item"]
    assert usuario["limite_restante"] == 470.00

def test_compra_intencao_expirada(mock_dynamodb):
    # Grava intenção já expirada no passado
    tab_int = mock_dynamodb.Table("teste-intencoes")
    passado = datetime.now(timezone.utc) - timedelta(minutes=15)
    passado_epoch = int(passado.timestamp())

    tab_int.put_item(Item={
        "intencao_id": "int_expirada_999",
        "usuario_id": "user_exp",
        "produto_id": "prod_001",
        "quantidade": 1,
        "valor_total": Decimal("249.90"),
        "moeda": "BRL",
        "status": "pendente",
        "criado_em": passado.isoformat(),
        "expira_em": passado.isoformat(),
        "expira_em_epoch": passado_epoch,
        "ttl": passado_epoch + 1000,
    })

    resp = comprar_handler({
        "usuario_id": "user_exp",
        "argumentos": {
            "intencao_id": "int_expirada_999",
            "metodo_pagamento": "cartao",
        },
    })
    assert resp["status"] == "recusado"
    assert resp["codigo"] == "INTENCAO_EXPIRADA"

def test_compra_limite_excedido(mock_dynamodb):
    # Usuário com limite baixo (50.00, como a Ana Souza da Fase 1)
    tab_usr = mock_dynamodb.Table("teste-usuarios")
    tab_usr.put_item(Item={
        "usuario_id": "user_ana",
        "limite": Decimal("50.00"),
        "limite_restante": Decimal("50.00"),
        "criado_em": datetime.now(timezone.utc).isoformat(),
    })

    # Tenta comprar Fone Bluetooth de 249.90
    reg = registrar_handler({
        "usuario_id": "user_ana",
        "argumentos": {"produto_id": "prod_001", "quantidade": 1},
    })

    resp = comprar_handler({
        "usuario_id": "user_ana",
        "argumentos": {
            "intencao_id": reg["intencao_id"],
            "metodo_pagamento": "cartao",
        },
    })

    assert resp["status"] == "recusado"
    assert resp["codigo"] == "LIMITE_EXCEDIDO"

    # Garante que o limite não mudou
    usr_atual = tab_usr.get_item(Key={"usuario_id": "user_ana"})["Item"]
    assert usr_atual["limite_restante"] == 50.00

def test_compra_sem_usuario_autenticado(mock_dynamodb):
    resp = comprar_handler({
        "argumentos": {"intencao_id": "int_123", "metodo_pagamento": "cartao"},
    })
    assert resp["status"] == "recusado"
    assert resp["codigo"] == "USUARIO_NAO_AUTENTICADO"

def test_mapear_erro_cancelamento_unitario(mock_dynamodb):
    tab_int = mock_dynamodb.Table("teste-intencoes")
    agora_epoch = int(datetime.now(timezone.utc).timestamp())

    # i=0: intenção com status 'paga'
    tab_int.put_item(Item={"intencao_id": "int_paga", "status": "paga", "expira_em_epoch": agora_epoch + 100})
    res0_paga = mapear_erro_cancelamento([{"Code": "ConditionalCheckFailed"}], tab_int, "int_paga", agora_epoch)
    assert res0_paga["codigo"] == "INTENCAO_JA_PAGA"

    # i=0: intenção expirada
    tab_int.put_item(Item={"intencao_id": "int_exp", "status": "pendente", "expira_em_epoch": agora_epoch - 10})
    res0_exp = mapear_erro_cancelamento([{"Code": "ConditionalCheckFailed"}], tab_int, "int_exp", agora_epoch)
    assert res0_exp["codigo"] == "INTENCAO_EXPIRADA"

    # i=1: limite excedido
    res1 = mapear_erro_cancelamento([{"Code": "None"}, {"Code": "ConditionalCheckFailed"}], tab_int, "int_qualquer", agora_epoch)
    assert res1["codigo"] == "LIMITE_EXCEDIDO"

    # i=2: transação duplicada
    res2 = mapear_erro_cancelamento([{"Code": "None"}, {"Code": "None"}, {"Code": "ConditionalCheckFailed"}], tab_int, "int_qualquer", agora_epoch)
    assert res2["codigo"] == "INTENCAO_JA_PAGA"
