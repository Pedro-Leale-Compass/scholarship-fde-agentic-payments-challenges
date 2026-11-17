from decimal import Decimal
from comum import tabela, extrair_evento, tratar_erros

@tratar_erros("listar_catalogo")
def handler(event, context=None):
    usuario_id, _ = extrair_evento(event)
    tab = tabela("TABELA_PRODUTOS")

    itens = []
    scan_kwargs = {}
    while True:
        resp = tab.scan(**scan_kwargs)
        itens.extend(resp.get("Items", []))
        last_key = resp.get("LastEvaluatedKey")
        if not last_key:
            break
        scan_kwargs["ExclusiveStartKey"] = last_key

    produtos = []
    for item in itens:
        preco_val = item.get("preco", 0)
        if isinstance(preco_val, Decimal):
            preco_float = float(round(preco_val, 2))
        else:
            preco_float = float(preco_val)

        produtos.append({
            "id": str(item.get("produto_id", "")),
            "nome": str(item.get("nome", "")),
            "preco": preco_float,
            "descricao": str(item.get("descricao", "")),
            "moeda": str(item.get("moeda", "BRL")),
        })

    produtos.sort(key=lambda p: p["id"])
    return {"produtos": produtos}
