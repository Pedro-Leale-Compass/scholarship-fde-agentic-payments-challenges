import json

from agente.lambdas import FALHA_NA_FERRAMENTA, invocar_tool
from conftest import FONE, USUARIO

LISTAR = "ana-braghim-tool-listar-catalogo"
REGISTRAR = "ana-braghim-tool-registrar-intencao"


def test_envia_usuario_e_argumentos_e_devolve_o_json_do_contrato(lambda_falsa):
    resposta = {"produtos": [{"id": FONE, "nome": "Fone", "preco": 249.9, "moeda": "BRL", "estoque": 12}]}
    lambda_falsa.responder(LISTAR, {"usuario_id": USUARIO, "argumentos": {"categoria": "audio"}}, resposta)

    resultado = invocar_tool("listar_catalogo", USUARIO, {"categoria": "audio"})

    assert json.loads(resultado) == resposta


def test_recusa_da_tool_volta_igual_para_o_modelo(lambda_falsa):
    recusa = {"status": "recusado", "erro": "ESTOQUE_INSUFICIENTE", "mensagem": "Estoque insuficiente."}
    lambda_falsa.responder(REGISTRAR, {"usuario_id": USUARIO, "argumentos": {"produto_id": FONE, "quantidade": 99}}, recusa)

    assert json.loads(invocar_tool("registrar_intencao", USUARIO, {"produto_id": FONE, "quantidade": 99})) == recusa


def test_erro_nao_tratado_na_lambda_vira_falha_na_ferramenta(lambda_falsa):
    lambda_falsa.responder(
        LISTAR,
        {"usuario_id": USUARIO, "argumentos": {}},
        {"errorType": "Error", "errorMessage": "segredo interno", "trace": ["stack"]},
        erro_funcao="Unhandled",
    )

    resultado = invocar_tool("listar_catalogo", USUARIO, {})

    assert json.loads(resultado) == FALHA_NA_FERRAMENTA
    assert "segredo" not in resultado


def test_falha_do_servico_lambda_vira_falha_na_ferramenta(lambda_falsa):
    lambda_falsa.falhar("TooManyRequestsException")

    assert json.loads(invocar_tool("listar_catalogo", USUARIO, {})) == FALHA_NA_FERRAMENTA


def test_resposta_que_nao_e_objeto_vira_falha_na_ferramenta(lambda_falsa):
    lambda_falsa.responder(LISTAR, {"usuario_id": USUARIO, "argumentos": {}}, ["lista"])

    assert json.loads(invocar_tool("listar_catalogo", USUARIO, {})) == FALHA_NA_FERRAMENTA


def test_resposta_que_nao_e_json_vira_falha_na_ferramenta(lambda_falsa):
    lambda_falsa.responder(LISTAR, {"usuario_id": USUARIO, "argumentos": {}}, b"nao e json")

    assert json.loads(invocar_tool("listar_catalogo", USUARIO, {})) == FALHA_NA_FERRAMENTA


def test_sem_usuario_nao_chama_a_lambda(lambda_falsa):
    # O Stubber não tem resposta enfileirada: qualquer chamada faria o teste falhar.
    assert json.loads(invocar_tool("realizar_compra", None, {"intencao_id": "x"})) == FALHA_NA_FERRAMENTA


def test_sem_variavel_de_ambiente_nao_chama_a_lambda(lambda_falsa, monkeypatch):
    monkeypatch.delenv("TOOL_LISTAR_CATALOGO")

    assert json.loads(invocar_tool("listar_catalogo", USUARIO, {})) == FALHA_NA_FERRAMENTA
