#!/usr/bin/env python3
"""Teste de integração local: chat do desafio via MiniStack (Bedrock emulator).

Simula o fluxo do agente de pagamentos chamando o Bedrock-Runtime emulado pelo
MiniStack, que por sua vez proxya para o llama.cpp (Qwen3.5 2B Q8).

Execução:
    cd Desafio-1/luiz-henrique/dev-tools
    python3 test-chat-local.py

Pré-requisito: docker compose up -d  (ministack + llama-server subidos).
"""

import json
import sys

import boto3

BEDROCK_ENDPOINT = "http://localhost:4566"
REGION = "us-east-1"
MODEL_ID = "qwen3.5"

# Tools do agente de pagamentos (espelho do plano em api/ e tools/)
# Formato bedrock-runtime Converse: toolSpec { name, description, inputSchema { json } }
TOOLS = [
    {
        "toolSpec": {
            "name": "listar_catalogo",
            "description": "Lista os produtos disponíveis para compra simulada.",
            "inputSchema": {"json": {"type": "object", "properties": {}, "required": []}},
        }
    },
    {
        "toolSpec": {
            "name": "registrar_intencao",
            "description": "Registra uma intenção de compra (produto, valor, forma de pagamento).",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "produto_id": {"type": "string"},
                        "valor": {"type": "number"},
                        "pagamento": {"type": "string", "enum": ["credito", "pix"]},
                    },
                    "required": ["produto_id", "valor", "pagamento"],
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "realizar_compra",
            "description": "Confirma e realiza a compra de uma intenção registrada.",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {"intencao_id": {"type": "string"}},
                    "required": ["intencao_id"],
                }
            },
        }
    },
]

bedrock = boto3.client(
    "bedrock-runtime",
    endpoint_url=BEDROCK_ENDPOINT,
    aws_access_key_id="test",
    aws_secret_access_key="test",
    region_name=REGION,
)


def converse(messages, tool_choice=None):
    kwargs = {
        "modelId": MODEL_ID,
        "messages": messages,
        "inferenceConfig": {"maxTokens": 400, "temperature": 0.7},
        "toolConfig": {"tools": TOOLS},
    }
    if tool_choice:
        kwargs["toolConfig"]["toolChoice"] = tool_choice
    return bedrock.converse(**kwargs)


def print_resp(label, resp):
    print(f"\n=== {label} ===")
    print(json.dumps(resp, indent=2, ensure_ascii=False, default=str))


def main():
    usuario_id = "dev-usuario-001"

    # 1) Saudação inicial — resposta gerada pelo Qwen3.5 via MiniStack Bedrock
    print(f"\n[1] Usuário {usuario_id} inicia o chat")
    messages = [
        {
            "role": "user",
            "content": [{"text": "Olá! Quero ver o catálogo de produtos e comprar algo com Pix."}],
        }
    ]
    resp = converse(messages)
    print_resp("Resposta do Bedrock (via MiniStack + llama.cpp Qwen3.5)", resp)

    output = resp.get("output", {})
    msg = output.get("message", {})
    content = msg.get("content", [])
    stop_reason = resp.get("stopReason")

    # Se o modelo solicitou uso de tool, simulamos a execução da tool localmente
    tool_requests = [c for c in content if "toolUse" in c]
    text_parts = [c["text"] for c in content if "text" in c and c["text"]]

    if text_parts:
        print("\n[Assistente diz]:", " ".join(text_parts))

    if stop_reason == "tool_use" and tool_requests:
        print(f"\n[2] Modelo solicitou {len(tool_requests)} tool(s); executando localmente")
        for req in tool_requests:
            tu = req["toolUse"]
            name = tu["name"]
            input_ = tu.get("input", {})
            print(f"    → Tool: {name} | input: {json.dumps(input_, ensure_ascii=False)}")

            # Simulação local das tools do desafio (espelho das Lambdas em tools/)
            if name == "listar_catalogo":
                tool_result = {
                    "produtos": [
                        {"id": "prod-1", "nome": "Produto A", "preco": 100.00},
                        {"id": "prod-2", "nome": "Produto B", "preco": 250.00},
                        {"id": "prod-3", "nome": "Produto C", "preco": 500.00},
                    ]
                }
            elif name == "registrar_intencao":
                tool_result = {
                    "ok": True,
                    "intencao_id": "int-001",
                    "produto_id": input_.get("produto_id"),
                    "valor": input_.get("valor"),
                    "pagamento": input_.get("pagamento"),
                    "usuario_id": usuario_id,
                    "status": "registrada",
                }
            elif name == "realizar_compra":
                tool_result = {
                    "ok": True,
                    "intencao_id": input_.get("intencao_id"),
                    "status": "paga",
                    "mensagem": "Compra realizada com sucesso (simulado).",
                }
            else:
                tool_result = {"error": f"tool desconhecida: {name}"}

            # Enviar resultado da tool de volta ao modelo
            messages.append(msg)
            messages.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "toolResult": {
                                "toolUseId": tu["toolUseId"],
                                "content": [{"json": tool_result}],
                            }
                        }
                    ],
                }
            )

        # Segunda chamada: modelo incorpora o resultado da tool e responde ao usuário
        resp2 = converse(messages)
        print_resp("Resposta após execução da tool (via MiniStack + Qwen3.5)", resp2)
        output2 = resp2.get("output", {})
        msg2 = output2.get("message", {})
        for c in msg2.get("content", []):
            if "text" in c and c["text"]:
                print("\n[Assistente final]:", c["text"])

    print("\n[OK] Fluxo de chat local concluído com MiniStack + llama.cpp (Qwen3.5 2B Q8).")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"\n[ERRO] {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
