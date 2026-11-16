import asyncio
import json

import boto3

from agente import REGIAO, criar_agente


USUARIO_ID = "1488e458-90a1-702e-1cdf-270c08704e31"

FUNCOES = {
    "listar_catalogo": "luis-filipe-mendes-nogueira-listar-catalogo",
    "registrar_intencao": "luis-filipe-mendes-nogueira-registrar-intencao",
    "realizar_compra": "luis-filipe-mendes-nogueira-realizar-compra",
}


class ClienteSomenteConsulta:
    def __init__(self, cliente):
        self.cliente = cliente
        self.chamadas = []

    def invoke(self, **kwargs):
        nome = kwargs["FunctionName"]

        if nome != FUNCOES["listar_catalogo"]:
            raise RuntimeError(
                "Este teste permite somente listar_catalogo."
            )

        payload = json.loads(kwargs["Payload"])

        if payload["contexto"]["usuario_id"] != USUARIO_ID:
            raise RuntimeError("Identidade inesperada na chamada.")

        self.chamadas.append(nome)
        return self.cliente.invoke(**kwargs)


async def main():
    sessao = boto3.Session(
        profile_name="luisfilipe",
        region_name=REGIAO,
    )

    cliente_lambda = sessao.client("lambda")
    try:
        consulta = ClienteSomenteConsulta(cliente_lambda)

        async with criar_agente(
            client_lambda=consulta,
            usuario_id=USUARIO_ID,
            funcoes=FUNCOES,
            perfil_aws="luisfilipe",
        ) as instancia:
            resultado = await instancia.invoke_async(
                "Consulte listar_catalogo e mostre os eventos "
                "disponíveis, com seus preços e vagas. "
                "Não registre intenções nem realize compras."
            )

            print("RESPOSTA:")
            print(str(resultado))

        if not consulta.chamadas:
            raise RuntimeError(
                "O agente respondeu sem chamar listar_catalogo."
            )

        print("\nOK — Lambda chamada com a identidade esperada.")

    finally:
        cliente_lambda.close()

if __name__ == "__main__":
    asyncio.run(main())