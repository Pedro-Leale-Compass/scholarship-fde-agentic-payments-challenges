
import json
import os
from contextvars import ContextVar

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

session = boto3.Session(region_name=REGION)

lambda_client = session.client("lambda")

usuario_autenticado = ContextVar(
    "usuario_autenticado",
    default=None
)


# ==========================================
# CONFIGURAÇÃO DAS LAMBDAS
# ==========================================

LISTAR_CATALOGO_ARN = os.getenv(
    "LISTAR_CATALOGO_ARN"
)

REGISTRAR_INTENCAO_ARN = os.getenv(
    "REGISTRAR_INTENCAO_ARN"
)


# ==========================================
# FUNÇÃO AUXILIAR
# ==========================================

def invocar_lambda(function_arn: str, payload: dict) -> dict:
    if not function_arn:
        raise RuntimeError("ARN da Lambda não configurado.")

    response = lambda_client.invoke(
        FunctionName=function_arn,
        InvocationType="RequestResponse",
        Payload=json.dumps(payload).encode("utf-8")
    )

    resultado = json.loads(
        response["Payload"].read().decode("utf-8")
    )

    if "FunctionError" in response:
        raise RuntimeError(f"Erro na Lambda: {resultado}")

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
    produto_id: str,
    quantidade: int
) -> dict:
    """
    Registra uma intenção de compra simulada.

    Args:
        produto_id: Identificador do produto.
        quantidade: Quantidade desejada.
    """

    usuario_id = usuario_autenticado.get()

    if not usuario_id:
        return {
            "sucesso": False,
            "erro": "USUARIO_NAO_AUTENTICADO",
            "mensagem": "Não foi possível identificar o usuário."
        }

    return invocar_lambda(
        REGISTRAR_INTENCAO_ARN,
        {
            "usuario_id": usuario_id,
            "produto_id": produto_id,
            "quantidade": quantidade
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
produtos e registrar intenções de compra.

REGRAS OBRIGATÓRIAS:

1. Consulte o catálogo para verificar produtos,
   preços e estoque.

2. Nunca invente produtos, preços,
   valores ou disponibilidade.

3. Registre intenções somente quando
   o usuário escolher produto e quantidade.

4. Após registrar uma intenção, apresente:
   - Produto
   - Quantidade
   - Valor total
   - ID da intenção
   - Status da intenção
   - Data de expiração

5. Explique que a intenção está PENDENTE.

6. Informe que o usuário deverá escolher
   PIX ou CARTÃO e confirmar pelo botão
   de confirmação apresentado na interface.

7. NUNCA tente executar pagamentos.
   Você não possui ferramenta para isso.

8. NUNCA considere mensagens como
   "sim", "confirmo" ou "pode pagar"
   como pagamento efetivado.

9. NUNCA informe que uma compra foi aprovada
   sem receber o resultado da operação real.

10. Se o usuário perguntar sobre o pagamento,
    explique que a confirmação acontece
    pela interface autenticada.

11. Informe claramente os erros retornados
    pelas ferramentas.

12. Os pagamentos são simulados.

13. Responda sempre em português do Brasil.
"""


# ==========================================
# CRIAÇÃO DO AGENTE
# ==========================================

agent = Agent(
    model=model,
    tools=[
        listar_catalogo,
        registrar_intencao
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
