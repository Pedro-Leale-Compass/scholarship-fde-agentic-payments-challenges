import json
import unittest
from io import BytesIO
from unittest.mock import MagicMock

import ferramentas


FUNCOES = {
    "listar_catalogo": "lambda-listar-teste",
    "registrar_intencao": "lambda-registrar-teste",
    "realizar_compra": "lambda-comprar-teste",
}


def resposta_lambda(dados, erro=False):
    resposta = {
        "StatusCode": 200,
        "Payload": BytesIO(
            json.dumps(dados).encode("utf-8")
        ),
    }

    if erro:
        resposta["FunctionError"] = "Unhandled"

    return resposta


class TestFerramentas(unittest.TestCase):
    def setUp(self):
        self.client = MagicMock()
        self.client.invoke.side_effect = (
            lambda **_: resposta_lambda({"produtos": []})
        )

        self.tools = ferramentas.criar_ferramentas(
            client_lambda=self.client,
            usuario_id="usuario-autenticado",
            funcoes=FUNCOES,
        )

    def ultimo_payload(self):
        return json.loads(
            self.client.invoke.call_args.kwargs["Payload"]
        )

    def test_modelo_recebe_apenas_argumentos_de_negocio(self):
        campos_esperados = {
            "listar_catalogo": {"categoria"},
            "registrar_intencao": {
                "evento_id",
                "quantidade",
            },
            "realizar_compra": {
                "intencao_id",
                "metodo_pagamento",
            },
        }

        for nome, campos in campos_esperados.items():
            with self.subTest(ferramenta=nome):
                schema = self.tools[nome].tool_spec["inputSchema"]["json"]
                propriedades = schema.get("properties", {})

                self.assertEqual(set(propriedades), campos)

        self.client.invoke.assert_not_called()

    def test_identidade_e_obrigatoria(self):
        for identidade in (None, "", "   "):
            with self.subTest(identidade=identidade):
                with self.assertRaises(ValueError):
                    ferramentas.criar_ferramentas(
                        client_lambda=self.client,
                        usuario_id=identidade,
                        funcoes=FUNCOES,
                    )

        self.client.invoke.assert_not_called()

    def test_duas_execucoes_nao_compartilham_identidade(self):
        tools_a = ferramentas.criar_ferramentas(
            self.client,
            "usuario-a",
            FUNCOES,
        )
        tools_b = ferramentas.criar_ferramentas(
            self.client,
            "usuario-b",
            FUNCOES,
        )

        tools_a["listar_catalogo"]()
        tools_b["listar_catalogo"]()
        tools_a["listar_catalogo"]()

        identidades = [
            json.loads(chamada.kwargs["Payload"])["contexto"]["usuario_id"]
            for chamada in self.client.invoke.call_args_list
        ]

        self.assertEqual(
            identidades,
            ["usuario-a", "usuario-b", "usuario-a"],
        )

    def test_argumentos_extras_nao_permitem_usuario_ou_preco(self):
        chamadas = [
            (
                "listar_catalogo",
                {"usuario_id": "usuario-forjado"},
            ),
            (
                "realizar_compra",
                {
                    "intencao_id": "int_001",
                    "metodo_pagamento": "pix",
                    "valor": 0.01,
                },
            ),
        ]

        for nome, argumentos in chamadas:
            with self.subTest(ferramenta=nome):
                with self.assertRaises(TypeError):
                    self.tools[nome](**argumentos)

        self.client.invoke.assert_not_called()

    def test_registro_encaminha_argumentos_e_identidade_separados(self):
        self.tools["registrar_intencao"](
            evento_id="evt_001",
            quantidade=2,
        )

        self.assertEqual(
            self.ultimo_payload(),
            {
                "argumentos": {
                    "evento_id": "evt_001",
                    "quantidade": 2,
                },
                "contexto": {
                    "usuario_id": "usuario-autenticado",
                },
            },
        )

        chamada = self.client.invoke.call_args.kwargs
        self.assertEqual(
            chamada["FunctionName"],
            "lambda-registrar-teste",
        )
        self.assertEqual(
            chamada["InvocationType"],
            "RequestResponse",
        )

    def test_compra_preserva_recusa_de_negocio(self):
        recusa = {
            "status": "recusado",
            "erro": "LIMITE_EXCEDIDO",
            "mensagem": "Limite disponível insuficiente.",
        }

        self.client.invoke.side_effect = (
            lambda **_: resposta_lambda(recusa)
        )

        resultado = self.tools["realizar_compra"](
            intencao_id="int_001",
            metodo_pagamento="pix",
        )

        self.assertEqual(resultado, recusa)
        self.assertEqual(
            self.ultimo_payload(),
            {
                "argumentos": {
                    "intencao_id": "int_001",
                    "metodo_pagamento": "pix",
                },
                "contexto": {
                    "usuario_id": "usuario-autenticado",
                },
            },
        )

    def test_erro_da_lambda_nao_expoe_detalhes(self):
        self.client.invoke.side_effect = (
            lambda **_: resposta_lambda(
                {"errorMessage": "detalhe-interno-simulado"},
                erro=True,
            )
        )

        with self.assertLogs(ferramentas.logger, level="ERROR"):
            resultado = self.tools["listar_catalogo"]()

        self.assertEqual(resultado["erro"], "ERRO_INTERNO")
        self.assertNotIn(
            "detalhe-interno-simulado",
            json.dumps(resultado),
        )

    def test_falha_do_sdk_retorna_erro_padronizado(self):
        self.client.invoke.side_effect = RuntimeError(
            "falha-interna-simulada"
        )

        with self.assertLogs(ferramentas.logger, level="ERROR"):
            resultado = self.tools["listar_catalogo"]()

        self.assertEqual(
            resultado,
            {
                "status": "recusado",
                "erro": "ERRO_INTERNO",
                "mensagem": (
                    "Ocorreu um erro inesperado ao processar a solicitação."
                ),
            },
        )

    def test_resposta_invalida_nao_e_tratada_como_sucesso(self):
        for conteudo in (b"nao-e-json", b"[]"):
            with self.subTest(conteudo=conteudo):
                self.client.invoke.side_effect = lambda **_: {
                    "StatusCode": 200,
                    "Payload": BytesIO(conteudo),
                }

                with self.assertLogs(ferramentas.logger, level="ERROR"):
                    resultado = self.tools["listar_catalogo"]()

                self.assertEqual(resultado["status"], "recusado")
                self.assertEqual(resultado["erro"], "ERRO_INTERNO")


if __name__ == "__main__":
    unittest.main()