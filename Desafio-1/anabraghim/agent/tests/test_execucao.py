"""Turno completo pelo entrypoint, com modelo roteirizado e Lambdas stubadas."""

import asyncio
import json

import pytest

import main
from agente import execucao
from agente.lambdas import FALHA_NA_FERRAMENTA
from agente.prompt import SYSTEM_PROMPT
from conftest import FONE, OUTRO_USUARIO, USUARIO, ModeloRoteirizado, coletar, mensagem_usuario, payload

REGISTRAR = "ana-braghim-tool-registrar-intencao"
LISTAR = "ana-braghim-tool-listar-catalogo"
INTENCAO = {
    "intencao_id": "20000000-0000-0000-0000-000000000001",
    "produto_id": FONE,
    "quantidade": 2,
    "valor_total": 499.8,
    "moeda": "BRL",
    "status": "pendente",
    "expira_em": "2026-11-15T12:15:00.000Z",
}


@pytest.fixture
def usar_modelo(monkeypatch):
    def configurar(roteiro):
        modelo = ModeloRoteirizado(roteiro)
        monkeypatch.setattr(execucao, "criar_modelo", lambda: modelo)
        return modelo

    return configurar


def rodar(entrada):
    return asyncio.run(coletar(main.invocar(entrada)))


def textos(eventos):
    return "".join(e["texto"] for e in eventos if e["tipo"] == "texto")


def test_resposta_simples_transmite_texto_e_devolve_mensagens_novas(usar_modelo):
    modelo = usar_modelo([("texto", "Olá! Como posso ajudar?")])

    eventos = rodar(payload("oi"))

    assert [e["tipo"] for e in eventos] == ["texto", "texto", "fim"]
    assert textos(eventos) == "Olá! Como posso ajudar?"
    assert eventos[-1]["mensagens_novas"] == [
        mensagem_usuario("oi"),
        {"role": "assistant", "content": [{"text": "Olá! Como posso ajudar?"}]},
    ]
    assert modelo.system_prompts == [SYSTEM_PROMPT]


def test_historico_completo_chega_ao_modelo(usar_modelo):
    historico = [mensagem_usuario(f"msg {i}") if i % 2 == 0 else {"role": "assistant", "content": [{"text": f"r {i}"}]} for i in range(60)]
    modelo = usar_modelo([("texto", "ok")])

    eventos = rodar(payload("e agora?", historico))

    # Nada é cortado (NullConversationManager): 60 do histórico + a nova.
    assert len(modelo.chamadas[0]) == 61
    assert len(eventos[-1]["mensagens_novas"]) == 2


def test_usuario_id_vem_do_payload_e_nao_do_modelo(usar_modelo, lambda_falsa):
    # O modelo tenta forjar outro usuário nos argumentos.
    modelo = usar_modelo(
        [
            ("tool", "registrar_intencao", {"produto_id": FONE, "quantidade": 2, "usuario_id": OUTRO_USUARIO}),
            ("texto", "Registrei a intenção."),
        ]
    )
    lambda_falsa.responder(REGISTRAR, {"usuario_id": USUARIO, "argumentos": {"produto_id": FONE, "quantidade": 2}}, INTENCAO)

    eventos = rodar(payload("quero 2 fones"))

    assert {"tipo": "ferramenta", "nome": "registrar_intencao"} in eventos
    resultado_da_tool = modelo.chamadas[1][-1]["content"][0]["toolResult"]
    assert json.loads(resultado_da_tool["content"][0]["text"]) == INTENCAO
    novas = eventos[-1]["mensagens_novas"]
    assert [m["role"] for m in novas] == ["user", "assistant", "user", "assistant"]
    assert "toolUse" in novas[1]["content"][0] and "toolResult" in novas[2]["content"][0]


def test_falha_da_tool_chega_ao_modelo_como_falha_na_ferramenta(usar_modelo, lambda_falsa):
    modelo = usar_modelo([("tool", "listar_catalogo", {}), ("texto", "Tive um problema, tente de novo.")])
    lambda_falsa.falhar()

    eventos = rodar(payload("o que tem?"))

    resultado = modelo.chamadas[1][-1]["content"][0]["toolResult"]["content"][0]["text"]
    assert json.loads(resultado) == FALHA_NA_FERRAMENTA
    assert eventos[-1]["tipo"] == "fim"


def test_payload_invalido_nao_chama_o_modelo(usar_modelo):
    modelo = usar_modelo([("texto", "não deveria")])

    eventos = rodar({"usuario_id": "forjado", "mensagens": [mensagem_usuario("oi")]})

    assert eventos == [{"tipo": "erro", "mensagem": execucao.MENSAGEM_ERRO}]
    assert modelo.chamadas == []


def test_erro_do_modelo_vira_evento_de_erro_sem_fim(usar_modelo):
    usar_modelo([("erro",)])

    eventos = rodar(payload("oi"))

    assert eventos[-1] == {"tipo": "erro", "mensagem": execucao.MENSAGEM_ERRO}
    assert all(e["tipo"] != "fim" for e in eventos)


def test_modelo_sem_configuracao_vira_evento_de_erro(monkeypatch):
    monkeypatch.delenv("MODELO_ID")

    assert rodar(payload("oi")) == [{"tipo": "erro", "mensagem": execucao.MENSAGEM_ERRO}]


def test_limite_de_turnos_fecha_a_conversa_com_o_assistente(usar_modelo, lambda_falsa):
    usar_modelo([("tool", "listar_catalogo", {})] * (execucao.MAX_TURNOS + 1))
    for _ in range(execucao.MAX_TURNOS):
        lambda_falsa.responder(LISTAR, {"usuario_id": USUARIO, "argumentos": {}}, {"produtos": []})

    eventos = rodar(payload("loop"))

    novas = eventos[-1]["mensagens_novas"]
    assert novas[-1] == {"role": "assistant", "content": [{"text": execucao.MENSAGEM_LIMITE}]}
    assert textos(eventos) == execucao.MENSAGEM_LIMITE


def test_tool_anunciada_uma_vez_por_chamada(usar_modelo, lambda_falsa):
    usar_modelo([("tool", "listar_catalogo", {}), ("texto", "pronto")])
    lambda_falsa.responder(LISTAR, {"usuario_id": USUARIO, "argumentos": {}}, {"produtos": []})

    eventos = rodar(payload("catálogo"))

    assert [e for e in eventos if e["tipo"] == "ferramenta"] == [{"tipo": "ferramenta", "nome": "listar_catalogo"}]


def test_eventos_sao_serializaveis_em_json(usar_modelo, lambda_falsa):
    usar_modelo([("tool", "listar_catalogo", {"categoria": "audio"}), ("texto", "Temos fones.")])
    lambda_falsa.responder(LISTAR, {"usuario_id": USUARIO, "argumentos": {"categoria": "audio"}}, {"produtos": []})

    for evento in rodar(payload("áudio")):
        json.dumps(evento, ensure_ascii=False)
