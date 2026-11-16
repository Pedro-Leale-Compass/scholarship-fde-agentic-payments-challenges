from agente.ferramentas import FERRAMENTAS


def test_schema_das_tools_nao_expoe_identidade_ao_modelo():
    specs = {f.tool_spec["name"]: f.tool_spec["inputSchema"]["json"] for f in FERRAMENTAS}

    assert set(specs) == {"listar_catalogo", "registrar_intencao", "realizar_compra"}
    for schema in specs.values():
        assert "usuario_id" not in schema["properties"]
        assert "tool_context" not in schema["properties"]
    assert set(specs["listar_catalogo"]["properties"]) == {"categoria"}
    assert specs["listar_catalogo"].get("required", []) == []
    assert set(specs["registrar_intencao"]["required"]) == {"produto_id", "quantidade"}
    assert set(specs["realizar_compra"]["required"]) == {"intencao_id", "metodo_pagamento"}


def test_metodo_pagamento_nao_e_enum():
    # Com enum o SDK recusaria antes da Lambda e METODO_INVALIDO não voltaria no formato padrão.
    spec = next(f.tool_spec for f in FERRAMENTAS if f.tool_spec["name"] == "realizar_compra")
    assert "enum" not in spec["inputSchema"]["json"]["properties"]["metodo_pagamento"]
