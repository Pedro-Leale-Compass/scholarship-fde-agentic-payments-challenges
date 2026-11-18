"""Lambda das tools: listar_catalogo, registrar_intencao e realizar_compra.

Uma Lambda só, com roteamento interno pelo campo "tool" do evento.
Evento esperado (montado pelo agente, nunca pelo modelo):
    {"tool": "<nome>", "usuario_id": "<sub do Cognito>", "args": {...}}

O usuario_id chega do backend; o modelo só preenche os argumentos de negócio.
"""
import os
import uuid
from datetime import datetime, timedelta, timezone

import boto3
from botocore.exceptions import ClientError

ddb = boto3.client("dynamodb")

T_USUARIOS = os.environ["TABELA_USUARIOS"]
T_CATALOGO = os.environ["TABELA_CATALOGO"]
T_INTENCOES = os.environ["TABELA_INTENCOES"]
T_TRANSACOES = os.environ["TABELA_TRANSACOES"]
LIMITE_PADRAO_CENTAVOS = int(os.environ.get("LIMITE_PADRAO_CENTAVOS", "200000"))
VALIDADE_INTENCAO_MIN = 10
METODOS_VALIDOS = ("cartao", "pix")


def recusado(erro: str, mensagem: str) -> dict:
    return {"status": "recusado", "erro": erro, "mensagem": mensagem}


def agora() -> datetime:
    return datetime.now(timezone.utc)


def _produto_publico(item: dict) -> dict:
    return {
        "id": item["produto_id"]["S"],
        "nome": item["nome"]["S"],
        "categoria": item["categoria"]["S"],
        "preco": int(item["preco_centavos"]["N"]) / 100,
        "moeda": item["moeda"]["S"],
        "estoque": int(item["estoque"]["N"]),
    }


def garantir_usuario(usuario_id: str) -> dict:
    """Cria o usuário com o limite padrão no primeiro acesso (sem sobrescrever)."""
    try:
        ddb.put_item(
            TableName=T_USUARIOS,
            Item={
                "usuario_id": {"S": usuario_id},
                "limite_centavos": {"N": str(LIMITE_PADRAO_CENTAVOS)},
                "gasto_centavos": {"N": "0"},
                "criado_em": {"S": agora().isoformat()},
            },
            ConditionExpression="attribute_not_exists(usuario_id)",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
    item = ddb.get_item(TableName=T_USUARIOS, Key={"usuario_id": {"S": usuario_id}}, ConsistentRead=True)["Item"]
    return {"limite": int(item["limite_centavos"]["N"]), "gasto": int(item["gasto_centavos"]["N"])}


def listar_catalogo(usuario_id: str, categoria: str | None = None) -> dict:
    itens = ddb.scan(TableName=T_CATALOGO)["Items"]  # shortcut: scan serve para catálogo pequeno; trocar por GSI se crescer
    produtos = [_produto_publico(i) for i in itens if int(i["estoque"]["N"]) > 0]
    if categoria:
        produtos = [p for p in produtos if p["categoria"] == categoria]
    return {"produtos": sorted(produtos, key=lambda p: p["id"])}


def registrar_intencao(usuario_id: str, produto_id: str, quantidade) -> dict:
    try:
        quantidade = int(quantidade)
    except (TypeError, ValueError):
        return recusado("QUANTIDADE_INVALIDA", "A quantidade fornecida não é um número válido.")
    if quantidade <= 0:
        return recusado("QUANTIDADE_INVALIDA", "Quantidade deve ser maior que zero.")

    produto = ddb.get_item(TableName=T_CATALOGO, Key={"produto_id": {"S": str(produto_id)}}).get("Item")
    if not produto:
        return recusado("PRODUTO_INVALIDO", "Produto não encontrado.")
    if quantidade > int(produto["estoque"]["N"]):
        return recusado("ESTOQUE_INSUFICIENTE", "Estoque insuficiente para a quantidade.")

    # O preço SEMPRE vem do banco, nunca do modelo.
    valor = int(produto["preco_centavos"]["N"]) * quantidade
    intencao_id = f"int_{uuid.uuid4().hex[:12]}"
    criada = agora()
    expira = criada + timedelta(minutes=VALIDADE_INTENCAO_MIN)

    ddb.put_item(
        TableName=T_INTENCOES,
        Item={
            "intencao_id": {"S": intencao_id},
            "usuario_id": {"S": usuario_id},
            "produto_id": {"S": produto_id},
            "quantidade": {"N": str(quantidade)},
            "valor_total_centavos": {"N": str(valor)},
            "moeda": {"S": produto["moeda"]["S"]},
            "status": {"S": "pendente"},
            "expira_em": {"S": expira.isoformat()},
            "criado_em": {"S": criada.isoformat()},
        },
        ConditionExpression="attribute_not_exists(intencao_id)",
    )
    return {
        "intencao_id": intencao_id,
        "produto_id": produto_id,
        "produto": produto["nome"]["S"],
        "quantidade": quantidade,
        "valor_total": valor / 100,
        "moeda": produto["moeda"]["S"],
        "status": "pendente",
        "expira_em": expira.isoformat(),
    }


def realizar_compra(usuario_id: str, intencao_id: str, metodo_pagamento: str) -> dict:
    if metodo_pagamento not in METODOS_VALIDOS:
        return recusado("METODO_INVALIDO", "Método de pagamento deve ser 'pix' ou 'cartao'.")

    intencao = ddb.get_item(
        TableName=T_INTENCOES, Key={"intencao_id": {"S": str(intencao_id)}}, ConsistentRead=True
    ).get("Item")
    # Intenção de outro usuário responde igual a inexistente, para não vazar que ela existe.
    if not intencao or intencao["usuario_id"]["S"] != usuario_id:
        return recusado("INTENCAO_INVALIDA", "A intenção informada não é válida para este usuário.")
    if intencao["status"]["S"] == "paga":
        return recusado("INTENCAO_JA_PAGA", "Essa intenção já foi utilizada.")
    momento = agora()
    if momento > datetime.fromisoformat(intencao["expira_em"]["S"]):
        return recusado("INTENCAO_EXPIRADA", "Essa intenção de compra expirou.")

    usuario = garantir_usuario(usuario_id)
    valor = int(intencao["valor_total_centavos"]["N"])
    disponivel = usuario["limite"] - usuario["gasto"]
    if valor > disponivel:
        return recusado("LIMITE_EXCEDIDO", "A compra ultrapassa o limite disponível.")

    transacao_id = f"tx_{uuid.uuid4().hex[:12]}"
    try:
        # Tudo ou nada. As condições impedem cobrança dupla mesmo com duas chamadas simultâneas:
        # só a primeira encontra a intenção "pendente" e o limite livre.
        ddb.transact_write_items(
            TransactItems=[
                {
                    "Update": {
                        "TableName": T_INTENCOES,
                        "Key": {"intencao_id": {"S": intencao_id}},
                        "UpdateExpression": "SET #s = :paga, transacao_id = :tx, metodo_pagamento = :m",
                        "ConditionExpression": "#s = :pendente AND usuario_id = :u AND expira_em > :agora",
                        "ExpressionAttributeNames": {"#s": "status"},
                        "ExpressionAttributeValues": {
                            ":paga": {"S": "paga"},
                            ":pendente": {"S": "pendente"},
                            ":tx": {"S": transacao_id},
                            ":m": {"S": metodo_pagamento},
                            ":u": {"S": usuario_id},
                            ":agora": {"S": momento.isoformat()},
                        },
                    }
                },
                {
                    "Update": {
                        "TableName": T_USUARIOS,
                        "Key": {"usuario_id": {"S": usuario_id}},
                        "UpdateExpression": "SET gasto_centavos = gasto_centavos + :v",
                        "ConditionExpression": "gasto_centavos <= :teto",
                        "ExpressionAttributeValues": {
                            ":v": {"N": str(valor)},
                            ":teto": {"N": str(usuario["limite"] - valor)},
                        },
                    }
                },
                {
                    "Update": {
                        "TableName": T_CATALOGO,
                        "Key": {"produto_id": {"S": intencao["produto_id"]["S"]}},
                        "UpdateExpression": "SET estoque = estoque - :q",
                        "ConditionExpression": "estoque >= :q",
                        "ExpressionAttributeValues": {":q": {"N": intencao["quantidade"]["N"]}},
                    }
                },
                {
                    "Put": {
                        "TableName": T_TRANSACOES,
                        "Item": {
                            "transacao_id": {"S": transacao_id},
                            "usuario_id": {"S": usuario_id},
                            "intencao_id": {"S": intencao_id},
                            "valor_centavos": {"N": str(valor)},
                            "metodo_pagamento": {"S": metodo_pagamento},
                            "criado_em": {"S": momento.isoformat()},
                        },
                        "ConditionExpression": "attribute_not_exists(transacao_id)",
                    }
                },
            ]
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "TransactionCanceledException":
            raise
        motivos = [r.get("Code") for r in e.response.get("CancellationReasons", [])]
        if motivos and motivos[0] == "ConditionalCheckFailed":
            # A intenção mudou entre a leitura e a escrita: outra chamada pagou primeiro ou expirou.
            atual = ddb.get_item(
                TableName=T_INTENCOES, Key={"intencao_id": {"S": intencao_id}}, ConsistentRead=True
            )["Item"]
            if atual["status"]["S"] == "paga":
                return recusado("INTENCAO_JA_PAGA", "Essa intenção já foi utilizada.")
            return recusado("INTENCAO_EXPIRADA", "Essa intenção de compra expirou.")
        if len(motivos) > 1 and motivos[1] == "ConditionalCheckFailed":
            return recusado("LIMITE_EXCEDIDO", "A compra ultrapassa o limite disponível.")
        if len(motivos) > 2 and motivos[2] == "ConditionalCheckFailed":
            return recusado("ESTOQUE_INSUFICIENTE", "Estoque insuficiente para a quantidade.")
        raise

    return {
        "status": "aprovado",
        "transacao_id": transacao_id,
        "intencao_id": intencao_id,
        "valor": valor / 100,
        "metodo_pagamento": metodo_pagamento,
        "limite_restante": (disponivel - valor) / 100,
        "data": momento.isoformat(),
    }


TOOLS = {
    "listar_catalogo": listar_catalogo,
    "registrar_intencao": registrar_intencao,
    "realizar_compra": realizar_compra,
}


def handler(event, context):
    nome = event.get("tool")
    usuario_id = event.get("usuario_id")
    args = event.get("args") or {}
    if not usuario_id:
        return recusado("USUARIO_AUSENTE", "Requisição sem usuário autenticado.")
    func = TOOLS.get(nome)
    if not func:
        return recusado("TOOL_INVALIDA", f"Ferramenta desconhecida: {nome}")
    try:
        return func(usuario_id, **args)
    except TypeError:
        return recusado("ARGUMENTOS_INVALIDOS", "Argumentos inválidos para a ferramenta.")
    except Exception as e:  # erro inesperado vira mensagem compreensível, sem stack trace para o usuário
        print(f"ERRO {nome}: {e!r}")
        return recusado("ERRO_INTERNO", "Falha interna ao executar a ferramenta. Tente novamente.")
