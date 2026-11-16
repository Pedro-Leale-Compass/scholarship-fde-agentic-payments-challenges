
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from agent import agent

app = BedrockAgentCoreApp()


@app.entrypoint
def invoke(payload, context):
    mensagem = payload.get("prompt", "")

    if not isinstance(mensagem, str) or not mensagem.strip():
        return {
            "erro": "Informe uma mensagem válida no campo prompt."
        }

    resposta = agent(mensagem)

    return {
        "resposta": str(resposta)
    }


if __name__ == "__main__":
    app.run()
