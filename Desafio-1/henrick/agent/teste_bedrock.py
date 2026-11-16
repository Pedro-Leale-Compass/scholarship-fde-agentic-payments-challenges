from strands import Agent
from strands.models import BedrockModel

modelo = BedrockModel(
    model_id="us.anthropic.claude-haiku-4-5-20251001-v1:0",
    region_name="us-east-1",
)

agente = Agent(
    model=modelo,
    system_prompt="Você é um assistente de compras. Responda sempre em português.",
)

agente("Olá! Em uma frase, o que você pode fazer por mim?")