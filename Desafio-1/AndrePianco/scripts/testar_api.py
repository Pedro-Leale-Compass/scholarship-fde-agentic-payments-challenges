"""Testa a API do webchat de ponta a ponta, com um usuario real do Cognito.

1. Requisicoes sem token / com token invalido -> 401 do API Gateway.
2. Login no Cognito (SRP, igual ao Amplify) e envio de mensagens em stream.
3. GET /conversas devolve o historico salvo.

Uso (na raiz do repo, depois do deploy com --outputs-file infra/cdk-outputs.json):
    uv run --no-project --with pycognito --with requests python scripts/testar_api.py \
        --email usuario@exemplo.com --senha 'SenhaDoUsuario1' "o que voces vendem?" "quero 1 mouse" "pix"

A senha tambem pode vir da variavel de ambiente SENHA_TESTE.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib

import requests
from pycognito import Cognito

RAIZ = pathlib.Path(__file__).resolve().parent.parent


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--email", required=True)
    p.add_argument("--senha", default=os.environ.get("SENHA_TESTE"))
    p.add_argument("mensagens", nargs="*")
    a = p.parse_args()

    s = json.loads((RAIZ / "infra" / "cdk-outputs.json").read_text())["AgentePagamentosBackend"]
    url = s["ApiUrl"].rstrip("/")

    print("== sem autenticacao")
    r = requests.post(f"{url}/chat", json={"mensagem": "oi"}, timeout=30)
    print(f"  POST /chat sem token        -> {r.status_code}")
    r = requests.post(f"{url}/chat", json={"mensagem": "oi"}, headers={"Authorization": "Bearer x.y.z"}, timeout=30)
    print(f"  POST /chat token invalido   -> {r.status_code}")

    print("== login no Cognito")
    u = Cognito(s["UserPoolId"], s["UserPoolClientId"], username=a.email, user_pool_region="us-east-1")
    u.authenticate(password=a.senha)
    cabecalho = {"Authorization": f"Bearer {u.id_token}"}
    print("  ok (ID token obtido)")

    for mensagem in a.mensagens:
        print(f"\n> {mensagem}")
        with requests.post(f"{url}/chat", json={"mensagem": mensagem}, headers=cabecalho, stream=True, timeout=180) as r:
            print(f"  [HTTP {r.status_code} {r.headers.get('content-type')}]")
            for linha in r.iter_lines(decode_unicode=True):
                if not linha or not linha.startswith("data: "):
                    continue
                ev = json.loads(linha[6:])
                if ev["tipo"] == "texto":
                    print(ev["delta"], end="", flush=True)
                elif ev["tipo"] == "tool_chamada":
                    print(f"\n  [tool] {ev['nome']}({json.dumps(ev['argumentos'], ensure_ascii=False)})")
                elif ev["tipo"] == "tool_resultado":
                    print(f"  [resultado] {json.dumps(ev['resultado'], ensure_ascii=False)[:200]}")
                elif ev["tipo"] == "erro":
                    print(f"\n  [erro] {ev['mensagem']}")
                elif ev["tipo"] == "fim":
                    print(f"\n  [fim: {ev.get('motivo')}]")

    r = requests.get(f"{url}/conversas", headers=cabecalho, timeout=30)
    print(f"\n== GET /conversas -> {r.status_code}, {len(r.json().get('mensagens', []))} mensagens no historico")


if __name__ == "__main__":
    main()
