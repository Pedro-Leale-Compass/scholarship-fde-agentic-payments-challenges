from strands import Agent, tool
from strands.models import BedrockModel

CATALOGO = [
    {"id": "prod_001", "nome": "Fone Bluetooth Aurora", "preco": 249.90, "estoque": 12},
    {"id": "prod_002", "nome": "Teclado Mecanico Kappa 75%", "preco": 419.00, "estoque": 7},
]


@tool
def listar_catalogo() -> list:
    """Lista os produtos disponiveis para compra, com id, nome, preco em BRL e estoque.
    Use sempre antes de registrar uma intencao de compra, para obter o id correto."""
    return CATALOGO


modelo = BedrockModel(
    model_id="us.anthropic.claude-haiku-4-5-20251001-v1:0",
    region_name="us-east-1",
)

agente = Agent(
    model=modelo,
    system_prompt="Voce e um assistente de compras. Use as ferramentas para qualquer informacao sobre produtos. Responda em portugues.",
    tools=[listar_catalogo],
)

agente("O que voces tem a venda?")