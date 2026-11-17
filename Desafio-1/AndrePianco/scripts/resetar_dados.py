"""Volta os dados da aplicacao ao estado inicial (antes de gravar evidencias).

- Catalogo: regrava os produtos de data/catalogo.seed.json (estoque original).
- Usuarios: limite_disponivel volta a ser igual a limite_total.
           Linhas de teste (user_id comecando com "teste-" ou e-mail
           @example.com, usados pelos scripts de teste) sao apagadas.
- Intencoes, transacoes e conversas: apagadas.

Nao mexe no Cognito: os usuarios continuam podendo entrar.

Uso (na raiz do repo):
    agent/.venv/Scripts/python scripts/resetar_dados.py --perfil seu-perfil
    agent/.venv/Scripts/python scripts/resetar_dados.py --perfil seu-perfil --sim   # sem confirmar
"""

from __future__ import annotations

import argparse
import json
import pathlib
from decimal import Decimal

import boto3

RAIZ = pathlib.Path(__file__).resolve().parent.parent


def esvaziar(tabela, chaves: list[str]) -> int:
    total = 0
    inicio = None
    with tabela.batch_writer() as lote:
        while True:
            args = {"ProjectionExpression": ", ".join(f"#k{i}" for i in range(len(chaves))),
                    "ExpressionAttributeNames": {f"#k{i}": k for i, k in enumerate(chaves)}}
            if inicio:
                args["ExclusiveStartKey"] = inicio
            pagina = tabela.scan(**args)
            for item in pagina["Items"]:
                lote.delete_item(Key={k: item[k] for k in chaves})
                total += 1
            inicio = pagina.get("LastEvaluatedKey")
            if not inicio:
                return total


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--perfil", default=None)
    p.add_argument("--sim", action="store_true", help="nao pedir confirmacao")
    a = p.parse_args()

    if not a.sim and input("Isso apaga intencoes, transacoes e conversas. Continuar? [s/N] ").lower() != "s":
        print("Cancelado.")
        return

    s = json.loads((RAIZ / "infra" / "cdk-outputs.json").read_text())["AgentePagamentosBackend"]
    db = boto3.Session(profile_name=a.perfil, region_name="us-east-1").resource("dynamodb")

    catalogo = db.Table(s["TabelaCatalogo"])
    produtos = json.loads((RAIZ / "data" / "catalogo.seed.json").read_text(encoding="utf-8"), parse_float=Decimal)
    with catalogo.batch_writer() as lote:
        for produto in produtos:
            lote.put_item(Item=produto)
    print(f"catalogo: {len(produtos)} produtos com estoque original")

    print(f"intencoes apagadas: {esvaziar(db.Table(s['TabelaIntencoes']), ['intencao_id'])}")
    print(f"transacoes apagadas: {esvaziar(db.Table(s['TabelaTransacoes']), ['transacao_id'])}")
    print(f"mensagens de conversa apagadas: {esvaziar(db.Table(s['TabelaConversas']), ['user_id', 'sk'])}")

    usuarios = db.Table(s["TabelaUsuarios"])
    restaurados = apagados = 0
    for u in usuarios.scan()["Items"]:
        if str(u["user_id"]).startswith("teste-") or str(u.get("email", "")).endswith("@example.com"):
            usuarios.delete_item(Key={"user_id": u["user_id"]})
            apagados += 1
        elif "limite_total" in u:
            usuarios.update_item(
                Key={"user_id": u["user_id"]},
                UpdateExpression="SET limite_disponivel = limite_total",
            )
            restaurados += 1
    print(f"usuarios: {restaurados} com limite restaurado, {apagados} de teste apagados")


if __name__ == "__main__":
    main()
