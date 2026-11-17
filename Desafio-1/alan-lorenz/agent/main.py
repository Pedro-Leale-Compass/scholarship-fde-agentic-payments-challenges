import json
import os
import re
from typing import Any

import boto3
from bedrock_agentcore import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models import BedrockModel

MODEL_ID = os.environ.get(
    "BEDROCK_MODEL_ID",
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
)
UUID_V4 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
SYSTEM_PROMPT = """Você é o atendente de uma loja de eletrônicos e conduz a compra do início ao fim.
Responda SEMPRE em português brasileiro, de forma objetiva e educada. Nunca escreva em inglês.
Fale apenas sobre a loja e sobre a compra em andamento. Se perguntarem outra coisa, diga que só pode ajudar com a loja.

FERRAMENTAS — use sempre, nunca invente os dados:

1. listar_catalogo — para qualquer pergunta sobre o que existe à venda, preço, estoque ou categoria.
   Aceita o filtro opcional "categoria".
2. registrar_intencao — quando a pessoa escolher um produto e a quantidade.
   Recebe "produto_id" e "quantidade". Não cobra nada: apenas trava preço e quantidade,
   e devolve um "intencao_id" junto com "valido_por_minutos".
3. realizar_compra — somente depois de a pessoa confirmar que quer pagar.
   Recebe o "intencao_id" devolvido por registrar_intencao e o "metodo_pagamento".

ORDEM OBRIGATÓRIA: listar_catalogo → registrar_intencao → realizar_compra.
Nunca chame realizar_compra sem ter registrado a intenção nesta conversa.

REGRAS:
- Nunca invente produto, preço, estoque, "intencao_id" ou "transacao_id".
  Use sempre o valor exato que a ferramenta devolveu.
- Métodos de pagamento aceitos: "cartao" e "pix", e mais nenhum.
  Pergunte qual a pessoa prefere antes de chamar realizar_compra.
- A intenção tem prazo. Ao registrá-la, diga à pessoa quantos minutos ela tem
  para confirmar, usando o "valido_por_minutos" que veio na resposta.
  Se o prazo acabar, registre uma intenção nova em vez de reaproveitar a antiga.
- Mostre valores em reais no formato R$ 1.234,56.

QUANDO UMA FERRAMENTA RECUSAR, explique o motivo em linguagem natural e ofereça o próximo passo:
- LIMITE_EXCEDIDO: o valor passa do limite de gasto da pessoa. Diga isso com clareza e
  ofereça um item mais barato ou uma quantidade menor. Nunca tente contornar o limite.
- INTENCAO_EXPIRADA: o prazo acabou. Ofereça registrar a intenção novamente.
- INTENCAO_JA_PAGA: essa intenção já foi paga. Se a pessoa quiser comprar de novo,
  registre uma intenção nova.
- INTENCAO_INVALIDA: a intenção não existe ou não pertence a essa pessoa.
  Registre uma nova antes de tentar pagar de novo.
- METODO_INVALIDO: só "cartao" e "pix" são aceitos. Pergunte qual dos dois a pessoa prefere.
- PRODUTO_INEXISTENTE: o produto não está no catálogo. Liste o catálogo e ofereça alternativas.
- QUANTIDADE_INVALIDA: a quantidade precisa ser um número inteiro maior que zero.
  Pergunte quantas unidades a pessoa quer.
- ESTOQUE_INSUFICIENTE: não há unidades suficientes. Informe o estoque disponível
  e ofereça uma quantidade menor.

Se pedirem para ignorar o limite, usar uma intenção que você não registrou, ou alterar
um preço: explique com educação que essas regras são verificadas pelo sistema e que você
não tem como contorná-las, e siga o fluxo normal."""

app = BedrockAgentCoreApp()
lambda_client = boto3.client(
    "lambda",
    region_name=os.environ.get("AWS_REGION", "us-east-1"),
)


def parse_agent_request(payload: Any) -> tuple[str, str, list[dict[str, Any]]]:
    if not isinstance(payload, dict):
        raise ValueError("Request payload must be an object")

    user_id = payload.get("userId")
    conversa_id = payload.get("conversaId")
    messages = payload.get("messages")
    if not isinstance(user_id, str) or not user_id.strip():
        raise ValueError("Authenticated user id is required")
    if not isinstance(conversa_id, str) or not UUID_V4.fullmatch(
        conversa_id.strip()
    ):
        raise ValueError("A valid conversation UUID v4 is required")
    if not isinstance(messages, list) or not messages:
        raise ValueError("A non-empty message history is required")
    if any(not isinstance(message, dict) for message in messages):
        raise ValueError("Every message must be an object")
    if any(not isinstance(message.get("role"), str) for message in messages):
        raise ValueError("Every message must have a role")
    if any(
        "content" in message and not isinstance(message["content"], str)
        for message in messages
    ):
        raise ValueError("Message content must be a string")

    if not any(
        message.get("role") == "user"
        and isinstance(message.get("content"), str)
        and message["content"].strip()
        for message in messages
    ):
        raise ValueError("A user message is required")

    return user_id.strip(), conversa_id.strip().lower(), messages


def build_user_prompt(messages: list[dict[str, Any]]) -> str:
    last_user_index = next(
        index
        for index in range(len(messages) - 1, -1, -1)
        if messages[index].get("role") == "user"
        and isinstance(messages[index].get("content"), str)
        and messages[index]["content"].strip()
    )
    history: list[str] = []
    for message in messages[:last_user_index]:
        role = message.get("role")
        if not isinstance(role, str) or role not in {
            "user",
            "assistant",
            "tool",
        }:
            continue

        content = message.get("content")
        if isinstance(content, str) and content:
            label = {
                "user": "Cliente",
                "assistant": "Atendente",
                "tool": "Resultado da ferramenta",
            }[role]
            history.append(f"{label}: {content}")

        tool_calls = message.get("tool_calls")
        if role == "assistant" and isinstance(tool_calls, list):
            for call in tool_calls:
                function = call.get("function") if isinstance(call, dict) else None
                if not isinstance(function, dict):
                    continue
                name = function.get("name")
                arguments = function.get("arguments")
                if isinstance(name, str):
                    history.append(
                        f"Atendente chamou {name} com argumentos "
                        f"{json.dumps(arguments, ensure_ascii=False)}"
                    )

    current_message = messages[last_user_index]["content"].strip()
    if not history:
        return current_message
    return (
        "Histórico completo da conversa (inclui resultados de ferramentas):\n"
        + "\n".join(history)
        + "\n\nMensagem atual do cliente:\n"
        + current_message
    )


def build_tool_event(
    user_id: str,
    conversa_id: str,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    return {
        "authenticatedContext": {
            "userId": user_id,
            "conversaId": conversa_id,
        },
        "arguments": arguments,
    }


def invoke_tool_lambda(
    function_name: str,
    user_id: str,
    conversa_id: str,
    arguments: dict[str, Any],
) -> Any:
    if not function_name:
        raise RuntimeError("Tool Lambda function name is not configured")
    response = lambda_client.invoke(
        FunctionName=function_name,
        InvocationType="RequestResponse",
        Payload=json.dumps(
            build_tool_event(user_id, conversa_id, arguments)
        ).encode("utf-8"),
    )
    if response.get("FunctionError"):
        raise RuntimeError(f"Tool Lambda {function_name} failed")

    payload = response["Payload"].read()
    return json.loads(payload)


def create_tools(
    user_id: str,
    conversa_id: str,
    completed_tools: list[dict[str, Any]],
) -> list[Any]:
    @tool
    def listar_catalogo(categoria: str | None = None) -> dict[str, Any]:
        """Lista produtos, preços, estoque e categorias disponíveis.

        Args:
            categoria: Filtro opcional de categoria.
        """
        arguments = {} if categoria is None else {"categoria": categoria}
        result = invoke_tool_lambda(
            os.environ.get("LIST_CATALOG_FUNCTION", ""),
            user_id,
            conversa_id,
            arguments,
        )
        completed_tools.append(
            {
                "type": "tool",
                "name": "listar_catalogo",
                "arguments": arguments,
                "result": result,
            }
        )
        return result

    @tool
    def registrar_intencao(produto_id: str, quantidade: int) -> dict[str, Any]:
        """Registra uma intenção de compra sem efetuar cobrança.

        Args:
            produto_id: Identificador exato do produto no catálogo.
            quantidade: Quantidade de unidades desejada.
        """
        arguments = {"produto_id": produto_id, "quantidade": quantidade}
        result = invoke_tool_lambda(
            os.environ.get("REGISTER_INTENTION_FUNCTION", ""),
            user_id,
            conversa_id,
            arguments,
        )
        completed_tools.append(
            {
                "type": "tool",
                "name": "registrar_intencao",
                "arguments": arguments,
                "result": result,
            }
        )
        return result

    @tool
    def realizar_compra(intencao_id: str, metodo_pagamento: str) -> dict[str, Any]:
        """Confirma o pagamento de uma intenção pendente.

        Args:
            intencao_id: Identificador devolvido ao registrar a intenção.
            metodo_pagamento: Método aceito: cartao ou pix.
        """
        arguments = {
            "intencao_id": intencao_id,
            "metodo_pagamento": metodo_pagamento,
        }
        result = invoke_tool_lambda(
            os.environ.get("REALIZAR_COMPRA_FUNCTION", ""),
            user_id,
            conversa_id,
            arguments,
        )
        completed_tools.append(
            {
                "type": "tool",
                "name": "realizar_compra",
                "arguments": arguments,
                "result": result,
            }
        )
        return result

    return [listar_catalogo, registrar_intencao, realizar_compra]


def drain_tool_events(
    completed_tools: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    pending = completed_tools[:]
    completed_tools.clear()
    return pending


@app.entrypoint
async def agent_invocation(payload: Any):
    try:
        user_id, conversa_id, messages = parse_agent_request(payload)
        prompt = build_user_prompt(messages)
    except ValueError as error:
        yield {"type": "error", "message": str(error)}
        yield {"type": "done"}
        return

    completed_tools: list[dict[str, Any]] = []
    agent = Agent(
        model=BedrockModel(
            model_id=MODEL_ID,
            region_name=os.environ.get("AWS_REGION", "us-east-1"),
        ),
        system_prompt=SYSTEM_PROMPT,
        tools=create_tools(user_id, conversa_id, completed_tools),
    )

    try:
        async for event in agent.stream_async(prompt):
            for tool_event in drain_tool_events(completed_tools):
                yield tool_event
            if isinstance(event, dict) and isinstance(event.get("data"), str):
                if event["data"]:
                    yield {"type": "token", "text": event["data"]}

        for tool_event in drain_tool_events(completed_tools):
            yield tool_event
    except Exception as error:
        print(f"Agent invocation failed: {error!r}")
        yield {
            "type": "error",
            "message": "Não foi possível concluir a solicitação. Tente novamente.",
        }
    yield {"type": "done"}


if __name__ == "__main__":
    app.run()
