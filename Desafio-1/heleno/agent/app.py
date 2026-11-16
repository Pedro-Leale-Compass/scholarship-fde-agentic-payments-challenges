
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from agent import agent, usuario_autenticado

app = BedrockAgentCoreApp()


@app.entrypoint
def invoke(payload, context):
    mensagem = payload.get("prompt", "")
    usuario_id = payload.get("usuario_id", "")

    if not isinstance(mensagem, str) or not mensagem.strip():
        return {
            "erro": "Informe uma mensagem válida no campo prompt."
        }

    if not isinstance(usuario_id, str) or not usuario_id.strip():
        return {
            "erro": "Identidade do usuário não informada."
        }

    # Vincula o usuário ao contexto desta execução.
    token = usuario_autenticado.set(usuario_id)

    try:
        resposta = agent(mensagem)

        return {
            "resposta": str(resposta)
        }

    finally:
        # Restaura o contexto anterior para evitar
        # vazamento de identidade entre execuções.
        usuario_autenticado.reset(token)


if __name__ == "__main__":
    app.run()
