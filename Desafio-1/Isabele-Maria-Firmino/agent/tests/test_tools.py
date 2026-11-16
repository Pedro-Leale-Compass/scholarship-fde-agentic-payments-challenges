import json
from types import SimpleNamespace
from typing import Any

import pytest

import tools
from tools import ERRO_INTERNO, create_compra, list_catalogo, register_intencao

USUARIO = "usuario-teste"
CONVERSA = "3f2a9c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f"


def create_contexto(**estado: Any) -> Any:
    return SimpleNamespace(invocation_state={"usuario_id": USUARIO, "conversa_id": CONVERSA, **estado})


def test_envia_identidade_do_invocation_state_e_argumentos_do_modelo(lambda_falsa):
    create_compra(intencao_id="int_abc123", metodo_pagamento="pix", tool_context=create_contexto())

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


def test_identidade_ausente_segue_como_none(lambda_falsa):
    list_catalogo(tool_context=SimpleNamespace(invocation_state={}))

    _, evento = lambda_falsa.eventos[0]
    assert evento["usuario_id"] is None
    assert evento["conversa_id"] is None


def test_cada_tool_chama_a_sua_lambda(lambda_falsa):
    contexto = create_contexto()

    list_catalogo(tool_context=contexto)
    register_intencao(produto_id="prod_001", quantidade=2, tool_context=contexto)
    create_compra(intencao_id="int_abc123", metodo_pagamento="cartao", tool_context=contexto)

    assert [nome for nome, _ in lambda_falsa.eventos] == [
        "teste-listar-catalogo",
        "teste-registrar-intencao",
        "teste-realizar-compra",
    ]
    assert lambda_falsa.eventos[1][1]["argumentos"] == {"produto_id": "prod_001", "quantidade": 2}


def test_catalogo_sem_categoria_envia_argumentos_vazios(lambda_falsa):
    contexto = create_contexto()

    list_catalogo(tool_context=contexto)
    list_catalogo(tool_context=contexto, categoria="audio")

    assert lambda_falsa.eventos[0][1]["argumentos"] == {}
    assert lambda_falsa.eventos[1][1]["argumentos"] == {"categoria": "audio"}


def test_devolve_a_resposta_da_lambda_como_json(lambda_falsa):
    recusa = {"status": "recusado", "erro": "PRODUTO_INEXISTENTE", "mensagem": "Produto não encontrado no catálogo."}
    lambda_falsa.respostas["teste-registrar-intencao"] = recusa

    resultado = register_intencao(produto_id="Fone Bluetooth", quantidade=1, tool_context=create_contexto())

    assert json.loads(resultado) == recusa
    assert "não encontrado no catálogo" in resultado


def test_function_error_vira_erro_interno(lambda_falsa, caplog):
    lambda_falsa.function_error = "Unhandled"

    resultado = create_compra(intencao_id="int_abc123", metodo_pagamento="pix", tool_context=create_contexto())

    assert json.loads(resultado) == ERRO_INTERNO
    assert "lambda falhou" in caplog.text


def test_excecao_do_boto3_vira_erro_interno(lambda_falsa, caplog):
    lambda_falsa.erro = RuntimeError("AccessDeniedException: sem permissão")

    resultado = create_compra(intencao_id="int_abc123", metodo_pagamento="pix", tool_context=create_contexto())

    assert json.loads(resultado) == ERRO_INTERNO
    assert "AccessDenied" not in resultado
    assert "AccessDenied" in caplog.text


def test_variavel_lambda_ausente_vira_erro_interno(lambda_falsa, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("LAMBDA_REALIZAR_COMPRA")

    resultado = create_compra(intencao_id="int_abc123", metodo_pagamento="pix", tool_context=create_contexto())

    assert json.loads(resultado) == ERRO_INTERNO
    assert lambda_falsa.eventos == []


def test_schema_nao_expoe_identidade():
    for ferramenta in tools.TOOLS:
        propriedades = ferramenta.tool_spec["inputSchema"]["json"]["properties"]
        for campo in ("tool_context", "usuario_id", "conversa_id"):
            assert campo not in propriedades, f"{ferramenta.tool_name} expõe {campo}"


def test_schema_segue_o_contrato_da_fase_1():
    schemas = {ferramenta.tool_name: ferramenta.tool_spec["inputSchema"]["json"] for ferramenta in tools.TOOLS}

    assert list(schemas) == ["listar_catalogo", "registrar_intencao", "realizar_compra"]
    assert schemas["listar_catalogo"].get("required", []) == []
    assert schemas["registrar_intencao"]["properties"]["quantidade"]["type"] == "integer"
    assert sorted(schemas["registrar_intencao"]["required"]) == ["produto_id", "quantidade"]
    assert schemas["realizar_compra"]["properties"]["metodo_pagamento"]["enum"] == ["cartao", "pix"]
    assert sorted(schemas["realizar_compra"]["required"]) == ["intencao_id", "metodo_pagamento"]
