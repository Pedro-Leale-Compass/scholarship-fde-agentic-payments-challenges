"""Agente Strands do ChatPay, hospedado no Bedrock AgentCore Runtime.

Payload recebido (montado pela Lambda do chat, nunca pelo modelo):
    {"usuario_id": "<sub do Cognito>", "mensagem": "<texto atual>", "historico": [<mensagens Strands>]}

Resposta em streaming (SSE), um evento por yield:
    {"tipo": "texto", "texto": "..."}          pedaços da resposta, para aparecer aos poucos na tela
    {"tipo": "fim", "mensagens": [...], ...}    mensagens novas do turno, para a Lambda salvar no histórico
"""
import json
import os
import re
import unicodedata

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models import BedrockModel

MODEL_ID = os.environ.get("MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0")
TOOLS_FUNCTION = os.environ["TOOLS_FUNCTION_NAME"]
REGION = os.environ.get("AWS_REGION", "us-east-1")

lambda_client = boto3.client("lambda", region_name=REGION)
app = BedrockAgentCoreApp()

SYSTEM_PROMPT = """
Você é o assistente do ChatPay, uma loja que vende por chat. Responda em português do Brasil, de forma curta.

Regras obrigatórias:
- Use as ferramentas para consultar o catálogo e executar operações de compra.
- Nunca invente produtos, valores, intenções, transações ou limites.
- Para comprar: registre a intenção com registrar_intencao, mostre produto, quantidade e valor total,
  e pergunte se o usuário quer pagar com Pix ou cartão.
- Nunca assuma o método de pagamento com base no histórico. Aguarde o usuário confirmar
  explicitamente Pix ou cartão na mensagem atual.
- Use em realizar_compra o intencao_id exatamente como a ferramenta devolveu.
- Se o usuário informar um intencao_id e confirmar Pix ou cartão, chame realizar_compra com ele mesmo que
  não o reconheça: quem valida a intenção é o sistema, não você. Depois explique o resultado.
- Só diga que uma compra foi aprovada quando realizar_compra retornar status "aprovado".
- Se uma ferramenta retornar uma recusa, explique o motivo em linguagem simples e não diga que a compra foi concluída.
- Não use Markdown (sem asteriscos, sem tabelas); escreva texto simples.
""".strip()


def normalizar(texto: str) -> str:
    sem_acento = unicodedata.normalize("NFKD", texto.lower())
    return "".join(c for c in sem_acento if not unicodedata.combining(c))


def detectar_metodo_confirmado(mensagem: str) -> str | None:
    """Retorna o método só quando a mensagem atual cita exatamente um (pix ou cartão)."""
    texto = normalizar(mensagem)
    metodos = [m for m, padrao in (("pix", r"\bpix\b"), ("cartao", r"\bcartao\b")) if re.search(padrao, texto)]
    return metodos[0] if len(metodos) == 1 else None


def afirma_aprovacao(texto: str) -> bool:
    t = normalizar(texto)
    if any(n in t for n in ("nao foi", "nao e possivel", "nao aprovad", "recusad", "falha", "erro")):
        return False
    return any(f in t for f in ("compra realizada", "compra aprovada", "pagamento realizado",
                                "pagamento aprovado", "transacao aprovada", "compra concluida"))


def chamar_tool(nome: str, usuario_id: str, args: dict) -> dict:
    resp = lambda_client.invoke(
        FunctionName=TOOLS_FUNCTION,
        Payload=json.dumps({"tool": nome, "usuario_id": usuario_id, "args": args}).encode(),
    )
    corpo = json.loads(resp["Payload"].read())
    if resp.get("FunctionError"):
        return {"status": "recusado", "erro": "ERRO_INTERNO", "mensagem": "Falha ao executar a ferramenta."}
    return corpo


def montar_tools(usuario_id: str, mensagem_atual: str, estado: dict):
    """As tools são criadas por requisição: o usuario_id fica preso aqui e o modelo nunca o vê."""

    @tool
    def listar_catalogo(categoria: str | None = None) -> dict:
        """Lista os produtos disponíveis no catálogo, com id, nome, preço e estoque.

        Args:
            categoria: filtro opcional de categoria (perifericos, audio, computadores).
        """
        return chamar_tool("listar_catalogo", usuario_id, {"categoria": categoria} if categoria else {})

    @tool
    def registrar_intencao(produto_id: str, quantidade: int) -> dict:
        """Registra uma intenção de compra (válida por 10 minutos) sem movimentar dinheiro.

        Args:
            produto_id: id do produto, como devolvido por listar_catalogo (ex.: prod_001).
            quantidade: quantidade desejada, maior que zero.
        """
        return chamar_tool("registrar_intencao", usuario_id, {"produto_id": produto_id, "quantidade": quantidade})

    @tool
    def realizar_compra(intencao_id: str, metodo_pagamento: str) -> dict:
        """Paga uma intenção registrada. Só chame depois que o usuário confirmar Pix ou cartão.

        Args:
            intencao_id: id devolvido por registrar_intencao (ex.: int_abc123).
            metodo_pagamento: "pix" ou "cartao".
        """
        metodo = normalizar(str(metodo_pagamento))
        confirmado = detectar_metodo_confirmado(mensagem_atual)
        # Métodos fora de pix/cartão seguem para a Lambda, que responde METODO_INVALIDO.
        if metodo in ("pix", "cartao"):
            if not confirmado:
                return {"status": "recusado", "erro": "CONFIRMACAO_PAGAMENTO_NECESSARIA",
                        "mensagem": "A mensagem atual do usuário precisa confirmar Pix ou cartão antes da compra."}
            if metodo != confirmado:
                return {"status": "recusado", "erro": "METODO_NAO_CONFIRMADO",
                        "mensagem": "O método escolhido não é o que o usuário confirmou."}
        resultado = chamar_tool("realizar_compra", usuario_id,
                                {"intencao_id": intencao_id, "metodo_pagamento": metodo})
        if resultado.get("status") == "aprovado":
            estado["compra_aprovada"] = True
        return resultado

    return [listar_catalogo, registrar_intencao, realizar_compra]


@app.entrypoint
async def invoke(payload, context=None):
    usuario_id = payload.get("usuario_id")
    mensagem = (payload.get("mensagem") or "").strip()
    historico = payload.get("historico") or []
    if not usuario_id or not mensagem:
        yield {"tipo": "erro", "mensagem": "Requisição inválida."}
        return

    estado = {"compra_aprovada": False}
    agente = Agent(
        model=BedrockModel(model_id=MODEL_ID, region_name=REGION, temperature=0.2),
        system_prompt=SYSTEM_PROMPT,
        tools=montar_tools(usuario_id, mensagem, estado),
        messages=historico,  # histórico completo da conversa a cada turno
        callback_handler=None,
    )
    inicio = len(agente.messages)

    try:
        separar = False
        async for evento in agente.stream_async(mensagem):
            if "message" in evento:
                separar = True  # terminou uma mensagem (ex.: antes de chamar tool); o próximo texto começa em linha nova
            elif "data" in evento and evento["data"]:
                texto = ("\n\n" if separar else "") + evento["data"]
                separar = False
                yield {"tipo": "texto", "texto": texto}
    except Exception as e:
        print(f"ERRO agente: {e!r}")
        yield {"tipo": "erro", "mensagem": "O assistente teve um problema para responder. Tente novamente."}
        return

    novas = agente.messages[inicio:]
    texto_final = ""
    if novas and novas[-1]["role"] == "assistant":
        texto_final = "".join(b.get("text", "") for b in novas[-1]["content"])

    # Rede de segurança: o modelo não pode afirmar compra que o backend não aprovou.
    if afirma_aprovacao(texto_final) and not estado["compra_aprovada"]:
        aviso = "\n\nAtenção: nenhuma compra foi aprovada pelo sistema nesta mensagem."
        yield {"tipo": "texto", "texto": aviso}
        novas[-1] = {"role": "assistant", "content": [{"text": texto_final + aviso}]}

    yield {"tipo": "fim", "mensagens": novas}


if __name__ == "__main__":
    app.run()
