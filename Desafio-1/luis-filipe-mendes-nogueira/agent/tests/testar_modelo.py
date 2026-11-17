import asyncio
import sys
from pathlib import Path

import boto3
from botocore.config import Config
from strands import Agent
from strands.models import BedrockModel

# Permite executar este script diretamente de qualquer diretório.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agente import MODELO_ID, REGIAO


async def main():
    sessao = boto3.Session(
        profile_name="luisfilipe",
        region_name=REGIAO,
    )

    modelo = BedrockModel(
        model_id=MODELO_ID,
        boto_session=sessao,
        boto_client_config=Config(
            connect_timeout=5,
            read_timeout=30,
            retries={
                "mode": "standard",
                "total_max_attempts": 1,
            },
        ),
        max_tokens=32,
        streaming=True,
    )

    try:
        agente = Agent(
            model=modelo,
            tools=[],
            callback_handler=None,
        )

        resultado = await agente.invoke_async(
            "Responda apenas com a palavra OK."
        )

        print("RESPOSTA:")
        print(str(resultado))
    finally:
        modelo.client.close()


if __name__ == "__main__":
    asyncio.run(main())
