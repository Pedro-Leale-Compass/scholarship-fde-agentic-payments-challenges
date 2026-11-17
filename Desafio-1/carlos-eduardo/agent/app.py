import json
import logging
import os
import re

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp  # type: ignore[import-not-found]
from strands import Agent, tool  # type: ignore[import-not-found]
from strands.models import BedrockModel  # type: ignore[import-not-found]

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = BedrockAgentCoreApp()
lambda_client = boto3.client("lambda", region_name=os.environ.get("AWS_REGION", "us-east-1"))
model_id = os.environ["BEDROCK_MODEL_ID"]

SYSTEM_PROMPT = """
Você é o assistente de compras ChatPay.
Regras obrigatórias:
1. Use SEMPRE as ferramentas no turno atual (`listar_catalogo`, `registrar_intencao`, `realizar_compra`, `consultar_historico_compras`). Nunca responda imitando o histórico sem chamar a ferramenta correspondente.
2. Mapeamento interno de produtos (uso exclusivo nas chamadas de ferramentas):
   - `prod_001`: Mouse Gamer (R$ 129,90)
   - `prod_002`: Teclado Mecânico (R$ 349,90)
   - `prod_003`: Fone Bluetooth (R$ 249,90)
   - `prod_004`: Notebook (R$ 4.599,90)
3. NUNCA exiba IDs internos para o usuário:
   - Ao listar o catálogo, mostre apenas **Produto**, **Preço** e **Estoque** (NÃO mostre `prod_001`, `prod_002`, etc.).
   - Ao registrar uma intenção de compra, NÃO mostre o `intencao_id` (`int_...`) na mensagem ao usuário; mostre apenas o produto, quantidade, valor total e pergunte se deseja pagar com Pix ou cartão.
4. Quando o usuário informar o método de pagamento (Pix ou cartão) ou pedir para confirmar uma intenção, chame `realizar_compra` neste turno.
5. Nunca invente preços, estoque, limite restante ou `transacao_id`, e nunca calcule saldo de cabeça.
6. Só afirme que a compra foi aprovada se `realizar_compra` retornar `status: "aprovado"` neste turno. Se retornar `status: "recusado"`, informe claramente o código `erro` e a `mensagem` da recusa.
""".strip()


def _invoke_tool(name, arguments, user_id, chat_id, confirmed_method, calls_log):
    response = lambda_client.invoke(
        FunctionName=os.environ[f"{name.upper()}_FUNCTION_ARN"],
        InvocationType="RequestResponse",
        Payload=json.dumps(
            {
                "arguments": arguments,
                "user_id": user_id,
                "chat_id": chat_id,
                "confirmed_method": confirmed_method,
            }
        ).encode("utf-8"),
    )
    if response.get("FunctionError"):
        logger.error("Tool Lambda %s returned a function error", name)
        raise RuntimeError("A ferramenta não pôde ser executada.")
    result = json.loads(response["Payload"].read())
    if not isinstance(result, dict):
        raise RuntimeError("A ferramenta retornou uma resposta inválida.")
    calls_log.append({"tool": name, "arguments": arguments, "result": result})
    return result


def _tools_for(user_id, chat_id, confirmed_method, calls_log, fallback_intent_id, explicit_intent_in_msg):
    @tool
    def listar_catalogo(categoria: str = "") -> dict:
        """Lista produtos disponíveis no catálogo. Ao responder ao usuário, mostre APENAS Nome, Preço e Estoque (nunca mostre o campo id prod_...)."""
        arguments = {"categoria": categoria} if categoria else {}
        return _invoke_tool("listar_catalogo", arguments, user_id, chat_id, confirmed_method, calls_log)

    @tool
    def registrar_intencao(produto_id: str, quantidade: int = 1) -> dict:
        """Registra uma intenção de compra (produto_id: 'prod_001', 'prod_002', 'prod_003' ou 'prod_004'). Nunca exiba o intencao_id na resposta ao usuário."""
        return _invoke_tool(
            "registrar_intencao",
            {"produto_id": produto_id, "quantidade": quantidade},
            user_id,
            chat_id,
            confirmed_method,
            calls_log,
        )

    @tool
    def realizar_compra(intencao_id: str, metodo_pagamento: str) -> dict:
        """Conclui a compra de uma intenção pendente. metodo_pagamento deve ser 'pix' ou 'cartao'."""
        resolved_id = intencao_id
        if not explicit_intent_in_msg:
            same_turn_intents = [
                e["result"].get("intencao_id")
                for e in calls_log
                if e["tool"] == "registrar_intencao" and e["result"].get("intencao_id")
            ]
            if same_turn_intents:
                resolved_id = same_turn_intents[-1]
            elif fallback_intent_id:
                resolved_id = fallback_intent_id
        return _invoke_tool(
            "realizar_compra",
            {"intencao_id": resolved_id, "metodo_pagamento": metodo_pagamento},
            user_id,
            chat_id,
            confirmed_method,
            calls_log,
        )

    @tool
    def consultar_historico_compras(limite: int = 3) -> dict:
        """Consulta as últimas compras aprovadas do usuário autenticado."""
        return _invoke_tool(
            "consultar_historico_compras",
            {"limite": limite},
            user_id,
            chat_id,
            confirmed_method,
            calls_log,
        )

    return [listar_catalogo, registrar_intencao, realizar_compra, consultar_historico_compras]


def _extract_text(result):
    content = result.message.get("content", [])
    text = "\n".join(
        block["text"]
        for block in content
        if isinstance(block, dict) and isinstance(block.get("text"), str)
    )
    return text if text else str(result)


@app.entrypoint
def invoke(payload):
    if not isinstance(payload, dict):
        raise ValueError("A solicitação do agente deve ser um objeto JSON.")
    user_id = payload.get("user_id")
    chat_id = payload.get("chat_id")
    message = payload.get("message")
    history = payload.get("history", [])
    confirmed_method = payload.get("confirmed_method")
    if (
        not isinstance(user_id, str)
        or not user_id
        or not isinstance(chat_id, str)
        or not chat_id
        or not isinstance(message, str)
        or not message.strip()
        or not isinstance(history, list)
    ):
        raise ValueError("A solicitação do agente está incompleta.")

    recent_history = [
        item
        for item in history[-10:]
        if isinstance(item, dict)
        and item.get("role") in ("user", "assistant")
        and isinstance(item.get("content"), str)
        and item["content"]
    ]
    raw_history_text = "\n".join(item["content"] for item in recent_history)
    found_intents = [
        item["intent_id"]
        for item in recent_history
        if isinstance(item.get("intent_id"), str) and item["intent_id"].startswith("int_")
    ]
    if not found_intents:
        found_intents = re.findall(r"int_[a-f0-9]{12}", raw_history_text)
    fallback_intent_id = found_intents[-1] if found_intents else None
    explicit_intent_in_msg = bool(re.search(r"\bint_[a-zA-Z0-9_]+\b", message))

    transcript = "\n".join(
        f"assistant [após executar ferramenta Lambda]: {item['content']}"
        if item["role"] == "assistant"
        else f"user: {item['content']}"
        for item in recent_history
    )
    intent_hint = (
        f"\nÚltimo intencao_id pendente registrado na conversa: {fallback_intent_id}"
        if fallback_intent_id and not explicit_intent_in_msg
        else ""
    )
    prompt = (
        f"<historico_recente>\n{transcript}{intent_hint}\n</historico_recente>\n\n"
        f"Mensagem atual do usuário (invoque a ferramenta necessária neste turno):\n{message}"
        if transcript
        else message
    )

    calls_log = []
    agent = Agent(
        model=BedrockModel(
            model_id=model_id,
            region_name=os.environ.get("AWS_REGION", "us-east-1"),
            streaming=False,
        ),
        tools=_tools_for(
            user_id,
            chat_id,
            confirmed_method,
            calls_log,
            fallback_intent_id,
            explicit_intent_in_msg,
        ),
        system_prompt=SYSTEM_PROMPT,
    )
    response = _extract_text(agent(prompt))

    called_tools = {entry["tool"] for entry in calls_log}
    lower = response.lower()
    hallucinated_intent = (
        "registrar_intencao" not in called_tools
        and ("intenção de compra foi registrada" in lower or ("intenção" in lower and "registrada" in lower))
    )
    hallucinated_purchase = (
        "realizar_compra" not in called_tools
        and (
            "compra aprovada" in lower
            or "concluída com sucesso" in lower
            or "processada com sucesso" in lower
            or "tx_" in lower
            or "limite restante" in lower
        )
    )

    missing_payment_call = (
        confirmed_method in ("pix", "cartao")
        and "realizar_compra" not in called_tools
        and "registrar_intencao" not in called_tools
        and (fallback_intent_id is not None or explicit_intent_in_msg)
    )

    if hallucinated_intent or hallucinated_purchase or missing_payment_call:
        logger.warning("Intercepted response without mandatory tool call; forcing tool execution.")
        response = _extract_text(
            agent(
                "Você respondeu sem chamar a ferramenta obrigatória neste turno. "
                "Chame agora `registrar_intencao` (para registrar um pedido) ou `realizar_compra` (para processar o pagamento) e responda apenas com os dados reais retornados."
            )
        )

    new_intent_id = None
    for entry in calls_log:
        if entry["tool"] == "registrar_intencao":
            intent_id = entry["result"].get("intencao_id")
            if isinstance(intent_id, str) and intent_id:
                new_intent_id = intent_id
        elif entry["tool"] == "realizar_compra":
            res = entry["result"]
            if res.get("status") == "recusado" and (
                "compra aprovada" in response.lower() or "concluída com sucesso" in response.lower()
            ):
                response = (
                    f"❌ **Compra Recusada ({res.get('erro', 'RECUSADO')})**\n\n"
                    f"{res.get('mensagem', 'A compra não pôde ser concluída.')}"
                )

    approved_calls = [
        e for e in calls_log
        if e["tool"] == "realizar_compra" and e["result"].get("status") == "aprovado"
    ]
    if not approved_calls and (
        "compra aprovada" in response.lower()
        or "concluída com sucesso" in response.lower()
        or "processada com sucesso" in response.lower()
        or "tx_" in response.lower()
    ):
        response = (
            "Nenhuma compra foi processada neste turno. "
            "Por favor, informe qual produto deseja comprar ou confirme o método de pagamento (Pix ou Cartão) para uma intenção pendente."
        )

    return {"response": response, "intent_id": new_intent_id}


if __name__ == "__main__":
    app.run()
