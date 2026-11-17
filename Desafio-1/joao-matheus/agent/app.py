import os
import json
from bedrock_agentcore import BedrockAgentCoreApp
from strands import Agent
from strands.models import BedrockModel
from prompt import SYSTEM_PROMPT
from ferramentas import criar_ferramentas
from historico import converter

app = BedrockAgentCoreApp()

model_id = os.environ.get("MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0")
region_name = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1"))
MODELO = BedrockModel(model_id=model_id, region_name=region_name, max_tokens=1024, temperature=0.2)

@app.entrypoint
async def invocar(payload, context=None):
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            payload = {}

    prompt = (payload.get("prompt") or "").strip()
    usuario_id = (payload.get("usuario_id") or "").strip()

    if not prompt or not usuario_id:
        yield {"tipo": "erro", "mensagem": "Requisição inválida: prompt e usuario_id são obrigatórios."}
        return

    historico_mensagens = converter(payload.get("historico", []))

    agente = Agent(
        model=MODELO,
        system_prompt=SYSTEM_PROMPT,
        tools=criar_ferramentas(usuario_id),
        messages=historico_mensagens,
        callback_handler=None,
    )

    ferramentas_anunciadas = set()

    try:
        async for ev in agente.stream_async(prompt):
            if not isinstance(ev, dict):
                continue

            if "data" in ev:
                yield {"tipo": "delta", "texto": ev["data"]}
            elif "current_tool_use" in ev:
                uso = ev["current_tool_use"]
                if isinstance(uso, dict):
                    uid = uso.get("toolUseId") or uso.get("name")
                    if uid and uid not in ferramentas_anunciadas:
                        ferramentas_anunciadas.add(uid)
                        yield {"tipo": "ferramenta", "nome": uso.get("name")}
    except Exception as e:
        print(json.dumps({
            "erro": type(e).__name__,
            "detalhe": str(e)[:500],
            "usuario_id": usuario_id,
        }, default=str))
        yield {"tipo": "erro", "mensagem": "Não consegui concluir sua solicitação agora. Tente novamente em instantes."}

    yield {"tipo": "fim"}

if __name__ == "__main__":
    app.run()
