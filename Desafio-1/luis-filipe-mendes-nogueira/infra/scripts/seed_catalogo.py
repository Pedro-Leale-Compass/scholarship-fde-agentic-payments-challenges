import argparse
import json
from pathlib import Path

import boto3

from boto3.dynamodb.types import TypeSerializer


def popular_catalogo(client, tabela_catalogo, eventos):
    serializador = TypeSerializer()

    # Prepara os itens antes de começar as escritas.
    itens = [
        {
            campo: serializador.serialize(valor)
            for campo, valor in evento.items()
        }
        for evento in eventos
    ]

    criados = 0
    existentes = 0

    for item in itens:
        try:
            client.put_item(
                TableName=tabela_catalogo,
                Item=item,
                ConditionExpression=(
                    "attribute_not_exists(evento_id)"
                ),
            )
            criados += 1

        except client.exceptions.ConditionalCheckFailedException:
            # Já existe: preserva preço, estoque e demais dados.
            existentes += 1

    return {
        "criados": criados,
        "existentes": existentes,
    }

def main():
    parser = argparse.ArgumentParser(
        description="Cadastra eventos ausentes sem sobrescrever estoque."
    )
    parser.add_argument("--profile", required=True)
    parser.add_argument(
        "--outputs-file",
        required=True,
        type=Path,
    )
    args = parser.parse_args()

    stack = "luis-filipe-mendes-nogueira-desafio-1"

    with args.outputs_file.open(encoding="utf-8") as arquivo:
        outputs = json.load(arquivo)

    nome_tabela = outputs.get(stack, {}).get("CatalogoTableName")

    if not isinstance(nome_tabela, str) or not nome_tabela:
        raise ValueError(
            "CatalogoTableName não encontrado nos outputs do deploy."
        )

    raiz_projeto = Path(__file__).resolve().parents[2]
    caminho_catalogo = (
        raiz_projeto
        / "tools"
        / "pagamentos"
        / "catalogo_inicial.json"
    )

    with caminho_catalogo.open(encoding="utf-8") as arquivo:
        eventos = json.load(arquivo)

    if not isinstance(eventos, list) or not eventos:
        raise ValueError("O catálogo inicial deve ser uma lista não vazia.")

    sessao = boto3.Session(
        profile_name=args.profile,
        region_name="us-east-1",
    )

    resultado = popular_catalogo(
        client=sessao.client("dynamodb"),
        tabela_catalogo=nome_tabela,
        eventos=eventos,
    )

    print(json.dumps(resultado, ensure_ascii=False))


if __name__ == "__main__":
    main()