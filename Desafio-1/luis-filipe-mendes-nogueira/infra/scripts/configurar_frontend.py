import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlsplit


STACK = "luis-filipe-mendes-nogueira-desafio-1"
RAIZ = Path(__file__).resolve().parents[2]


def validar_url(valor):
    if not isinstance(valor, str) or not valor.strip():
        raise ValueError("URL ausente nos outputs.")

    endereco = valor.strip().rstrip("/")
    partes = urlsplit(endereco)

    if (
        partes.scheme != "https"
        or not re.fullmatch(
            r"[a-z0-9]+\.execute-api\.us-east-1\.amazonaws\.com",
            partes.netloc,
        )
        or partes.query
        or partes.fragment
    ):
        raise ValueError("URL de API inesperada nos outputs.")

    return endereco


def montar_config(outputs):
    valores = outputs.get(STACK)

    if not isinstance(valores, dict):
        raise ValueError("Stack não encontrada nos outputs.")

    regiao = valores.get("Region")
    pool = valores.get("UserPoolId")
    cliente = valores.get("UserPoolClientId")

    if (
        regiao != "us-east-1"
        or not isinstance(pool, str)
        or not pool.startswith("us-east-1_")
        or not isinstance(cliente, str)
        or not cliente.strip()
    ):
        raise ValueError("Outputs do Cognito inválidos.")

    return {
        "apiUrl": validar_url(valores.get("ApiUrl")),
        "chatApiUrl": validar_url(valores.get("ChatApiUrl")),
        "cognito": {
            "region": regiao,
            "userPoolId": pool,
            "userPoolClientId": cliente,
        },
    }


def atualizar(caminho_outputs, raiz=RAIZ):
    outputs = json.loads(
        Path(caminho_outputs).read_text(encoding="utf-8")
    )
    config = montar_config(outputs)

    conteudo = json.dumps(
        config,
        ensure_ascii=False,
        indent=2,
    ) + "\n"

    destinos = [raiz / "frontend" / "public" / "config.json"]

    exportacao = raiz / "frontend" / "out"
    if exportacao.is_dir():
        destinos.append(exportacao / "config.json")

    for destino in destinos:
        destino.parent.mkdir(parents=True, exist_ok=True)
        temporario = destino.with_suffix(".json.tmp")
        temporario.write_text(conteudo, encoding="utf-8")
        temporario.replace(destino)

    return config


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--outputs-file",
        type=Path,
        default=RAIZ / "infra" / "cdk.out" / "outputs.json",
    )
    args = parser.parse_args()

    config = atualizar(args.outputs_file)

    print("Configuração pública atualizada.")
    print(f"API de perfil: {config['apiUrl']}")
    print(f"API do chat: {config['chatApiUrl']}")


if __name__ == "__main__":
    main()
