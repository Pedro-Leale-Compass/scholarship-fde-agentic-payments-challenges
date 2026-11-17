import json
import logging
from typing import Literal

from strands import tool


logger = logging.getLogger(__name__)


def criar_ferramentas(client_lambda, usuario_id, funcoes):
    if not isinstance(usuario_id, str) or not usuario_id.strip():
        raise ValueError("Identidade autenticada obrigatória.")

    # Copia a configuração para não depender de alterações externas.
    nomes = {}

    for nome in (
        "listar_catalogo",
        "registrar_intencao",
        "realizar_compra",
    ):
        destino = funcoes.get(nome)

        if not isinstance(destino, str) or not destino:
            raise ValueError(f"Lambda não configurada: {nome}")

        nomes[nome] = destino

    def invocar(nome, argumentos):
        try:
            resposta = client_lambda.invoke(
                FunctionName=nomes[nome],
                InvocationType="RequestResponse",
                Payload=json.dumps(
                    {
                        "argumentos": argumentos,
                        "contexto": {
                            "usuario_id": usuario_id,
                        },
                    },
                    ensure_ascii=False,
                ).encode("utf-8"),
            )

            if (
                resposta.get("StatusCode") != 200
                or resposta.get("FunctionError")
            ):
                raise RuntimeError("Falha na execução da Lambda.")

            resultado = json.loads(resposta["Payload"].read())

            if not isinstance(resultado, dict):
                raise ValueError("Resposta inesperada da ferramenta.")

            return resultado

        except Exception:
            logger.exception("Falha ao invocar ferramenta %s.", nome)

            return {
                "status": "recusado",
                "erro": "ERRO_INTERNO",
                "mensagem": (
                    "Ocorreu um erro inesperado ao processar a solicitação."
                ),
            }

    @tool
    def listar_catalogo(categoria: str = "") -> dict:
        """Lista os eventos disponíveis e seus preços e estoques.

        Args:
            categoria: Categoria opcional para filtrar os eventos.
        """
        argumentos = {}

        if categoria:
            argumentos["categoria"] = categoria

        return invocar("listar_catalogo", argumentos)

    @tool
    def registrar_intencao(evento_id: str, quantidade: int) -> dict:
        """Reserva ingressos e cria uma intenção válida por cinco minutos.

        O backend calcula o valor usando o preço do catálogo.

        Args:
            evento_id: Identificador retornado pelo catálogo.
            quantidade: Quantidade inteira e positiva de ingressos.
        """
        return invocar(
            "registrar_intencao",
            {
                "evento_id": evento_id,
                "quantidade": quantidade,
            },
        )

    @tool
    def realizar_compra(
        intencao_id: str,
        metodo_pagamento: Literal["cartao", "pix"],
    ) -> dict:
        """Realiza uma compra simulada usando uma intenção registrada.

        Use após o usuário confirmar a compra e escolher o método.
        O backend obtém o valor da intenção e verifica o limite.

        Args:
            intencao_id: Identificador retornado por registrar_intencao.
            metodo_pagamento: Método escolhido pelo usuário: cartao ou pix.
        """
        return invocar(
            "realizar_compra",
            {
                "intencao_id": intencao_id,
                "metodo_pagamento": metodo_pagamento,
            },
        )

    return {
        "listar_catalogo": listar_catalogo,
        "registrar_intencao": registrar_intencao,
        "realizar_compra": realizar_compra,
    }