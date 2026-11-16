from historico import converter

def test_converter_historico_descarta_mensagens_iniciais_de_assistant():
    historico = [
        {"role": "assistant", "texto": "Olá! Como posso ajudar?"},
        {"role": "user", "texto": "Quais produtos vocês têm?"},
        {"role": "assistant", "texto": "Temos Fone Bluetooth, Carregador e Cabo."},
    ]
    msgs = converter(historico)

    assert len(msgs) == 2
    assert msgs[0]["role"] == "user"
    assert msgs[0]["content"][0]["text"] == "Quais produtos vocês têm?"
    assert msgs[1]["role"] == "assistant"
    assert msgs[1]["content"][0]["text"] == "Temos Fone Bluetooth, Carregador e Cabo."

def test_converter_historico_mescla_mensagens_consecutivas_mesmo_papel():
    historico = [
        {"role": "user", "texto": "Quero comprar algo."},
        {"role": "user", "texto": "Me mostra os cabos."},
        {"role": "assistant", "texto": "Temos o Cabo USB por R$ 30,00."},
        {"role": "assistant", "texto": "Deseja quantas unidades?"},
    ]
    msgs = converter(historico)

    assert len(msgs) == 2
    assert msgs[0]["role"] == "user"
    assert msgs[0]["content"][0]["text"] == "Quero comprar algo.\nMe mostra os cabos."
    assert msgs[1]["role"] == "assistant"
    assert msgs[1]["content"][0]["text"] == "Temos o Cabo USB por R$ 30,00.\nDeseja quantas unidades?"

def test_converter_historico_ignora_entradas_vazias_ou_invalidas():
    historico = [
        {"role": "system", "texto": "ignorar"},
        {"role": "user", "texto": ""},
        {"role": "user", "texto": "   "},
        None,
        123,
        {"role": "user", "texto": "Mensagem válida"},
    ]
    msgs = converter(historico)

    assert len(msgs) == 1
    assert msgs[0]["role"] == "user"
    assert msgs[0]["content"][0]["text"] == "Mensagem válida"

def test_converter_historico_limita_30_mensagens():
    historico = []
    for i in range(40):
        role = "user" if i % 2 == 0 else "assistant"
        historico.append({"role": role, "texto": f"Mensagem {i}"})

    msgs = converter(historico)
    assert len(msgs) <= 30
    assert msgs[0]["role"] == "user"
