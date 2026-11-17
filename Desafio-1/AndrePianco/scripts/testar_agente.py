"""Conversa com o agente no AgentCore Runtime direto (sem API Gateway).

Simula o que a Lambda do chat faz: envia user_id + historico + mensagem e
imprime o stream de eventos. O historico e mantido entre as mensagens.

Uso (na raiz do repo, depois do deploy com --outputs-file infra/cdk-outputs.json):
    agent/.venv/Scripts/python scripts/testar_agente.py --perfil seu-perfil --usuario teste-usuario-a \
        "o que voces vendem?" "quero 1 mouse vertical" "pago no pix"
"""

from __future__ import annotations

import argparse
import json
import pathlib
import uuid

import boto3

RAIZ = pathlib.Path(__file__).resolve().parent.parent


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--perfil", default=None)
    p.add_argument("--usuario", required=True, help="user_id que a Lambda do chat enviaria (sub do Cognito)")
    p.add_argument("mensagens", nargs="+")
    a = p.parse_args()

    saidas = json.loads((RAIZ / "infra" / "cdk-outputs.json").read_text())["AgentePagamentosBackend"]
    cliente = boto3.Session(profile_name=a.perfil, region_name="us-east-1").client("bedrock-agentcore")
    sessao = f"teste-{uuid.uuid4()}"  # >= 33 caracteres
    historico: list[dict] = []

    for mensagem in a.mensagens:
        print(f"\n\033[1m> {mensagem}\033[0m")
        resposta = cliente.invoke_agent_runtime(
            agentRuntimeArn=saidas["AgenteRuntimeArn"],
            runtimeSessionId=sessao,
            payload=json.dumps({"user_id": a.usuario, "historico": historico, "mensagem": mensagem}),
            contentType="application/json",
            accept="text/event-stream",
        )
        for linha in resposta["response"].iter_lines():
            if not linha or not linha.startswith(b"data: "):
                continue
            evento = json.loads(linha[6:])
            tipo = evento.get("tipo")
            if tipo == "texto":
                print(evento["delta"], end="", flush=True)
            elif tipo == "tool_chamada":
                print(f"\n  \033[36m[tool] {evento['nome']}({json.dumps(evento['argumentos'], ensure_ascii=False)})\033[0m")
            elif tipo == "tool_resultado":
                print(f"  \033[36m[resultado] {json.dumps(evento['resultado'], ensure_ascii=False)[:300]}\033[0m")
            elif tipo == "erro":
                print(f"\n  \033[31m[erro] {evento['mensagem']}\033[0m")
            elif tipo == "fim":
                historico.extend(evento["mensagens"])
                print(f"\n  \033[90m[fim: {evento.get('motivo')}, historico={len(historico)} mensagens]\033[0m")


if __name__ == "__main__":
    main()
