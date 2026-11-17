import json
from unittest.mock import patch, MagicMock
from ferramentas import criar_ferramentas

def test_schema_das_ferramentas_nao_expoe_usuario_id_nem_valor():
    tools = criar_ferramentas("user_seguro_123")
    assert len(tools) == 3

    nomes_esperados = {"listar_catalogo", "registrar_intencao", "realizar_compra"}
    nomes_encontrados = set()

    for t in tools:
        spec = t.tool_spec
        nome = spec["name"]
        nomes_encontrados.add(nome)

        props = spec.get("inputSchema", {}).get("json", {}).get("properties", {})
        required = spec.get("inputSchema", {}).get("json", {}).get("required", [])

        # Validação crítica de segurança: usuario_id e valor NUNCA podem aparecer no schema do LLM
        assert "usuario_id" not in props, f"usuario_id exposto indevidamente na tool {nome}"
        assert "usuario_id" not in required, f"usuario_id marcado como obrigatório na tool {nome}"
        assert "valor" not in props, f"valor exposto indevidamente na tool {nome}"
        assert "valor" not in required, f"valor marcado como obrigatório na tool {nome}"

        if nome == "listar_catalogo":
            assert len(props) == 0
        elif nome == "registrar_intencao":
            assert "produto_id" in props
            assert "quantidade" in props
            assert props["produto_id"]["type"] == "string"
            assert props["quantidade"]["type"] == "integer"
            assert set(required) == {"produto_id", "quantidade"}
        elif nome == "realizar_compra":
            assert "intencao_id" in props
            assert "metodo_pagamento" in props
            assert props["intencao_id"]["type"] == "string"
            assert props["metodo_pagamento"]["type"] == "string"
            assert set(required) == {"intencao_id", "metodo_pagamento"}

    assert nomes_encontrados == nomes_esperados

@patch("ferramentas.obter_lambda_client")
def test_limite_de_chamadas_por_turno(mock_obter_client):
    mock_client = MagicMock()
    mock_client.invoke.return_value = {
        "Payload": MagicMock(read=lambda: b'{"produtos": []}'),
    }
    mock_obter_client.return_value = mock_client

    tools = criar_ferramentas("user_123")
    listar = tools[0]

    # Pode chamar até 6 vezes
    for _ in range(6):
        res = json.loads(listar())
        assert res.get("codigo") != "LIMITE_EXCEDIDO_TURNO"

    # A 7ª chamada deve ser bloqueada
    res_bloqueada = json.loads(listar())
    assert res_bloqueada["status"] == "recusado"
    assert res_bloqueada["codigo"] == "LIMITE_EXCEDIDO_TURNO"
