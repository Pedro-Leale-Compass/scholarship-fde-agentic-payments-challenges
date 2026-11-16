
import json
import os

import boto3
from strands import Agent, tool
from strands.models import BedrockModel


# ==========================================
# CONFIGURAÇÕES AWS
# ==========================================

REGION = os.getenv("AWS_REGION", "us-east-1")

MODEL_ID = os.getenv(
    "BEDROCK_MODEL_ID",
    "us.anthropic.claude-haiku-4-5-20251001-v1:0"
)

# Localmente: utiliza AWS_PROFILE, quando definido.
# No AgentCore: utiliza a IAM role do runtime.
session = boto3.Session(region_name=REGION)

lambda_client = session.client("lambda")


# ==========================================
# CONFIGURAÇÃO DAS LAMBDAS
# ==========================================

LISTAR_CATALOGO_ARN = os.getenv(
    "LISTAR_CATALOGO_ARN"
)

REGISTRAR_INTENCAO_ARN = os.getenv(
    "REGISTRAR_INTENCAO_ARN"
)

REALIZAR_COMPRA_ARN = os.getenv(
    "REALIZAR_COMPRA_ARN"
)


# ==========================================
# FUNÇÃO AUXILIAR
# ==========================================

def invocar_lambda(function_arn: str, payload: dict) -> dict:
    if not function_arn:
        raise RuntimeError(
            "ARN da Lambda não configurado."
        )

    response = lambda_client.invoke(
        FunctionName=function_arn,
        InvocationType="RequestResponse",
        Payload=json.dumps(payload).encode("utf-8")
    )

    resultado = json.loads(
        response["Payload"].read().decode("utf-8")
    )

    if "FunctionError" in response:
        raise RuntimeError(
            f"Erro na Lambda: {resultado}"
        )

    return resultado


# ==========================================
# FERRAMENTA 1 - LISTAR CATÁLOGO
# ==========================================

@tool
def listar_catalogo(categoria: str = "") -> dict:
    """
    Lista os produtos disponíveis no catálogo.

    Args:
        categoria: Categoria desejada.
                   Deixe vazio para listar todos.

    Returns:
        Produtos, preços e estoques disponíveis.
    """

    payload = {}

    if categoria:
        payload["categoria"] = categoria

    return invocar_lambda(
        LISTAR_CATALOGO_ARN,
        payload
    )


# ==========================================
# FERRAMENTA 2 - REGISTRAR INTENÇÃO
# ==========================================

@tool
def registrar_intencao(
    usuario_id: str,
    produto_id: str,
    quantidade: int
) -> dict:
    """
    Registra uma intenção de compra simulada.

    Args:
        usuario_id: Identificador do usuário.
        produto_id: Identificador do produto.
        quantidade: Quantidade desejada.

    Returns:
        ID da intenção, valor e status.
    """

    return invocar_lambda(
        REGISTRAR_INTENCAO_ARN,
        {
            "usuario_id": usuario_id,
            "produto_id": produto_id,
            "quantidade": quantidade
        }
    )


# ==========================================
# FERRAMENTA 3 - REALIZAR COMPRA
# ==========================================

@tool
def realizar_compra(
    intencao_id: str,
    usuario_id: str,
    metodo_pagamento: str
) -> dict:
    """
    Realiza uma compra simulada.

    Somente deve ser utilizada após
    confirmação explícita do usuário.

    Args:
        intencao_id: Identificador da intenção.
        usuario_id: Identificador do usuário.
        metodo_pagamento: PIX ou CARTAO.

    Returns:
        Resultado do pagamento simulado.
    """

    return invocar_lambda(
        REALIZAR_COMPRA_ARN,
        {
            "intencao_id": intencao_id,
            "usuario_id": usuario_id,
            "metodo_pagamento": metodo_pagamento
        }
    )


# ==========================================
# MODELO BEDROCK
# ==========================================

model = BedrockModel(
    model_id=MODEL_ID,
    boto_session=session,
    temperature=0.2
)


# ==========================================
# INSTRUÇÕES DO AGENTE
# ==========================================

SYSTEM_PROMPT = """
Você é o assistente de compras Agentic Payments.

Sua função é ajudar os usuários a consultar
produtos, registrar intenções e realizar
compras simuladas.

REGRAS OBRIGATÓRIAS:

1. Consulte o catálogo para verificar
   produtos, preços e estoque.

2. Nunca invente produtos, preços,
   valores ou disponibilidade.

3. Registre intenções apenas quando
   o usuário escolher produto e quantidade.

4. Antes de realizar uma compra,
   apresente produto, quantidade,
   valor total e método de pagamento.

5. Aguarde confirmação explícita
   do usuário antes de realizar o pagamento.

6. Nunca invente aprovações de pagamento.

7. Informe claramente os erros
   retornados pelas ferramentas.

8. Os pagamentos são simulados.

9. Responda sempre em português do Brasil.
"""


# ==========================================
# CRIAÇÃO DO AGENTE
# ==========================================

agent = Agent(
    model=model,
    tools=[
        listar_catalogo,
        registrar_intencao,
        realizar_compra
    ],
    system_prompt=SYSTEM_PROMPT
)


# ==========================================
# EXECUÇÃO LOCAL
# ==========================================

if __name__ == "__main__":
    print("\nAgentic Payments iniciado!")
    print("Digite 'sair' para encerrar.\n")

    while True:
        mensagem = input("Você: ").strip()

        if mensagem.lower() in ["sair", "exit"]:
            break

        if not mensagem:
            continue

        try:
            resposta = agent(mensagem)
            print(f"\nAgente: {resposta}\n")

        except Exception as error:
            print(f"\nErro: {error}\n")
