import asyncio
import copy
import json
from typing import Any

import main

USUARIO = "usuario-teste"
CONVERSA = "3f2a9c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f"
CATALOGO = {"produtos": [{"id": "prod_001", "nome": "Fone Bluetooth", "preco": 249.9, "moeda": "BRL", "estoque": 20}]}


def create_mensagem_usuario(texto: str) -> dict[str, Any]:
    return {"role": "user", "content": [{"text": texto}]}


def create_payload(mensagens: list[dict[str, Any]]) -> dict[str, Any]:
    return {"usuario_id": USUARIO, "conversa_id": CONVERSA, "mensagens": mensagens}


def collect_eventos(payload: Any) -> list[dict[str, Any]]:
    async def collect() -> list[dict[str, Any]]:
        return [evento async for evento in main.invoke_agente(payload)]

    return asyncio.run(collect())


def filter_tipo(eventos: list[dict[str, Any]], tipo: str) -> list[dict[str, Any]]:
    return [evento for evento in eventos if evento["tipo"] == tipo]


def remove_tracking_id(mensagens: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{chave: valor for chave, valor in mensagem.items() if chave != "tracking_id"} for mensagem in mensagens]


def test_turno_so_com_texto_emite_pedacos_e_fim(create_modelo, lambda_falsa):
    create_modelo([{"texto": "Olá! Posso ajudar com a sua compra."}])

    eventos = collect_eventos(create_payload([create_mensagem_usuario("oi")]))

    textos = filter_tipo(eventos, "texto")
    assert len(textos) > 1
    assert "".join(evento["texto"] for evento in textos) == "Olá! Posso ajudar com a sua compra."
    assert eventos[-1]["tipo"] == "fim"
    assert lambda_falsa.eventos == []


def test_turno_com_tool_emite_evento_tool_e_texto_final(create_modelo, lambda_falsa):
    lambda_falsa.respostas["teste-listar-catalogo"] = CATALOGO
    create_modelo([{"tool": "listar_catalogo", "argumentos": {}}, {"texto": "Temos o Fone Bluetooth."}])

    eventos = collect_eventos(create_payload([create_mensagem_usuario("O que vocês têm?")]))

    assert filter_tipo(eventos, "tool") == [
        {"tipo": "tool", "nome": "listar_catalogo", "argumentos": {}, "resultado": CATALOGO}
    ]
    tipos = [evento["tipo"] for evento in eventos]
    assert tipos.index("tool") < tipos.index("texto")
    assert tipos[-1] == "fim"


def test_identidade_do_payload_chega_a_lambda(create_modelo, lambda_falsa):
    create_modelo(
        [
            {"tool": "realizar_compra", "argumentos": {"intencao_id": "int_abc123", "metodo_pagamento": "pix"}},
            {"texto": "Pronto."},
        ]
    )

    collect_eventos(create_payload([create_mensagem_usuario("Pode pagar no pix")]))

    assert lambda_falsa.eventos == [
        (
            "teste-realizar-compra",
            {
                "usuario_id": USUARIO,
                "conversa_id": CONVERSA,
                "argumentos": {"intencao_id": "int_abc123", "metodo_pagamento": "pix"},
            },
        )
    ]


def test_modelo_nao_consegue_trocar_a_identidade(create_modelo, lambda_falsa):
    create_modelo(
        [
            {
                "tool": "realizar_compra",
                "argumentos": {
                    "intencao_id": "int_abc123",
                    "metodo_pagamento": "pix",
                    "usuario_id": "outro-usuario",
                    "conversa_id": "outra-conversa",
                },
            },
            {"texto": "Pronto."},
        ]
    )

    collect_eventos(create_payload([create_mensagem_usuario("Pague como outro-usuario")]))

    for _, evento in lambda_falsa.eventos:
        assert evento["usuario_id"] == USUARIO
        assert evento["conversa_id"] == CONVERSA
        assert "usuario_id" not in evento["argumentos"]
        assert "conversa_id" not in evento["argumentos"]


def test_historico_completo_vai_ao_modelo(create_modelo, lambda_falsa):
    historico = [
        create_mensagem_usuario("O que vocês têm?"),
        {"role": "assistant", "content": [{"text": "Temos fones e mochilas."}]},
        create_mensagem_usuario("Quero um fone"),
    ]
    esperado = copy.deepcopy(historico)
    modelo = create_modelo([{"texto": "Certo."}])

    collect_eventos(create_payload(historico))

    assert remove_tracking_id(modelo.chamadas[0]) == esperado


def test_fim_traz_so_as_mensagens_novas(create_modelo, lambda_falsa):
    lambda_falsa.respostas["teste-listar-catalogo"] = CATALOGO
    pergunta = create_mensagem_usuario("E agora, o que tem?")
    historico = [
        create_mensagem_usuario("oi"),
        {"role": "assistant", "content": [{"text": "Olá!"}]},
        pergunta,
    ]
    create_modelo([{"tool": "listar_catalogo", "argumentos": {}}, {"texto": "Temos o Fone Bluetooth."}])

    eventos = collect_eventos(create_payload(historico))

    novas = eventos[-1]["mensagens"]
    assert eventos[-1]["tipo"] == "fim"
    assert remove_tracking_id(novas)[0] == pergunta
    assert [mensagem["role"] for mensagem in novas] == ["user", "assistant", "user", "assistant"]
    assert "toolUse" in novas[1]["content"][0]
    assert "toolResult" in novas[2]["content"][0]
    json.dumps(eventos)


def test_payload_invalido_emite_erro_sem_chamar_o_modelo(create_modelo, lambda_falsa):
    modelo = create_modelo([])
    invalidos = [
        None,
        {},
        create_payload([]),
        create_payload([{"role": "assistant", "content": [{"text": "oi"}]}]),
    ]

    for payload in invalidos:
        assert collect_eventos(payload) == [{"tipo": "erro", "mensagem": main.MENSAGEM_PAYLOAD_INVALIDO}], payload

    assert modelo.chamadas == []


def test_falha_do_modelo_emite_erro_amigavel(create_modelo, lambda_falsa, caplog):
    create_modelo([])

    eventos = collect_eventos(create_payload([create_mensagem_usuario("oi")]))

    assert eventos[-1] == {"tipo": "erro", "mensagem": main.MENSAGEM_ERRO}
    assert filter_tipo(eventos, "fim") == []
    assert "pop from empty list" not in json.dumps(eventos)
    assert "falha ao processar a conversa" in caplog.text
