import os
from uuid import uuid4
from decimal import Decimal
from datetime import timedelta
from comum import tabela, extrair_evento, recusa, agora_utc, tratar_erros

@tratar_erros("registrar_intencao")
def handler(event, context=None):
    usuario_id, argumentos = extrair_evento(event)

    produto_id = argumentos.get("produto_id")
    if not produto_id or not isinstance(produto_id, str) or not produto_id.strip():
        return recusa("PRODUTO_NAO_ENCONTRADO", "ID do produto é obrigatório.")
    produto_id = produto_id.strip()

    quantidade = argumentos.get("quantidade")
    # Rejeita booleanos (em Python bool é subclasse de int: isinstance(True, int) == True)
    # Rejeita floats e valores fora do intervalo [1, 100]
    if isinstance(quantidade, bool) or not isinstance(quantidade, int) or quantidade < 1 or quantidade > 100:
        return recusa("QUANTIDADE_INVALIDA", "Quantidade deve ser um número inteiro positivo entre 1 e 100.")

    # 1. Buscar produto no DynamoDB
    tab_produtos = tabela("TABELA_PRODUTOS")
    resp_prod = tab_produtos.get_item(Key={"produto_id": produto_id})
    produto = resp_prod.get("Item")
    if not produto:
        return recusa("PRODUTO_NAO_ENCONTRADO", f"Produto com ID '{produto_id}' não encontrado no catálogo.")

    # 2. Calcular valor total no backend usando Decimal
    preco_unitario = produto.get("preco")
    if not isinstance(preco_unitario, Decimal):
        preco_unitario = Decimal(str(preco_unitario))

    valor_total = (preco_unitario * Decimal(quantidade)).quantize(Decimal("0.01"))

    # 3. Gerar IDs e datas
    agora = agora_utc()
    minutos_expiracao = int(os.environ.get("MINUTOS_EXPIRACAO", "10"))
    expira_em = agora + timedelta(minutes=minutos_expiracao)
    expira_em_epoch = int(expira_em.timestamp())
    ttl_limpeza = expira_em_epoch + (7 * 86400) # 7 dias após expirar

    intencao_id = f"int_{uuid4().hex}"

    item_intencao = {
        "intencao_id": intencao_id,
        "usuario_id": usuario_id,
        "produto_id": produto_id,
        "quantidade": quantidade,
        "valor_total": valor_total,
        "moeda": "BRL",
        "status": "pendente",
        "criado_em": agora.isoformat(),
        "expira_em": expira_em.isoformat(),
        "expira_em_epoch": expira_em_epoch,
        "ttl": ttl_limpeza,
    }

    tab_intencoes = tabela("TABELA_INTENCOES")
    tab_intencoes.put_item(
        Item=item_intencao,
        ConditionExpression="attribute_not_exists(intencao_id)"
    )

    return {
        "intencao_id": intencao_id,
        "produto_id": produto_id,
        "quantidade": quantidade,
        "valor_total": float(valor_total),
        "moeda": "BRL",
        "status": "pendente",
        "expira_em": expira_em.isoformat(),
    }
