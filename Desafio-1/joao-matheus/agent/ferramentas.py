import os
import json
import boto3
from strands import tool

def obter_lambda_client():
    region = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1"))
    return boto3.client("lambda", region_name=region)

def invocar_lambda(arn: str, usuario_id: str, argumentos: dict) -> str:
    try:
        client = obter_lambda_client()
        payload_bytes = json.dumps({
            "usuario_id": usuario_id,
            "argumentos": argumentos,
        }).encode("utf-8")

        resp = client.invoke(
            FunctionName=arn,
            Payload=payload_bytes,
        )
        corpo = resp["Payload"].read().decode("utf-8")

        if resp.get("FunctionError"):
            return json.dumps({
                "status": "recusado",
                "codigo": "ERRO_FERRAMENTA",
                "mensagem": "A ferramenta falhou. Tente novamente em instantes.",
            }, ensure_ascii=False)

        return corpo
    except Exception as exc:
        return json.dumps({
            "status": "recusado",
            "codigo": "ERRO_COMUNICACAO",
            "mensagem": f"Não foi possível contatar a ferramenta: {str(exc)}",
        }, ensure_ascii=False)

def criar_ferramentas(usuario_id: str) -> list:
    chamadas = [0]
    MAX_CHAMADAS = 6

    def verificar_limite() -> str | None:
        chamadas[0] += 1
        if chamadas[0] > MAX_CHAMADAS:
            return json.dumps({
                "status": "recusado",
                "codigo": "LIMITE_EXCEDIDO_TURNO",
                "mensagem": "Limite de operações de ferramenta por turno atingido.",
            }, ensure_ascii=False)
        return None

    @tool
    def listar_catalogo() -> str:
        """Lista todos os produtos disponíveis no catálogo com ID, nome, preço e descrição."""
        bloqueio = verificar_limite()
        if bloqueio:
            return bloqueio
        arn = os.environ.get("TOOL_LISTAR_CATALOGO_ARN", "")
        return invocar_lambda(arn, usuario_id, {})

    @tool
    def registrar_intencao(produto_id: str, quantidade: int) -> str:
        """Registra uma nova intenção de compra. O valor total é calculado pelo sistema e a intenção expira em 10 minutos.

        Args:
            produto_id: ID do produto (ex.: prod_001), obtido em listar_catalogo.
            quantidade: Quantidade desejada (inteiro positivo entre 1 e 100).
        """
        bloqueio = verificar_limite()
        if bloqueio:
            return bloqueio
        arn = os.environ.get("TOOL_REGISTRAR_INTENCAO_ARN", "")
        return invocar_lambda(arn, usuario_id, {
            "produto_id": produto_id,
            "quantidade": quantidade,
        })

    @tool
    def realizar_compra(intencao_id: str, metodo_pagamento: str) -> str:
        """Processa o pagamento de uma intenção de compra previamente registrada. Só chame após confirmação explícita do usuário.

        Args:
            intencao_id: ID retornado por registrar_intencao (ex.: int_...).
            metodo_pagamento: Método escolhido ('cartao' ou 'pix').
        """
        bloqueio = verificar_limite()
        if bloqueio:
            return bloqueio
        arn = os.environ.get("TOOL_REALIZAR_COMPRA_ARN", "")
        return invocar_lambda(arn, usuario_id, {
            "intencao_id": intencao_id,
            "metodo_pagamento": metodo_pagamento,
        })

    return [listar_catalogo, registrar_intencao, realizar_compra]
