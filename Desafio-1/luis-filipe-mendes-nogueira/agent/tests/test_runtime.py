import unittest
from copy import deepcopy
from unittest.mock import AsyncMock, MagicMock, patch

import runtime


VARIAVEIS = {
    "LISTAR_CATALOGO_FUNCTION": "lambda-listar",
    "REGISTRAR_INTENCAO_FUNCTION": "lambda-registrar",
    "REALIZAR_COMPRA_FUNCTION": "lambda-comprar",
}


class TestRuntime(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        patch_env = patch.dict(runtime.os.environ, VARIAVEIS)
        patch_env.start()
        self.addCleanup(patch_env.stop)

        self.cliente_lambda = MagicMock()

        patch_cliente = patch.object(
            runtime.boto3,
            "client",
            return_value=self.cliente_lambda,
        )
        self.criar_cliente = patch_cliente.start()
        self.addCleanup(patch_cliente.stop)

        self.instancia = MagicMock()
        self.instancia.invoke_async = AsyncMock(
            return_value="Resposta simulada."
        )
        self.instancia.messages = [
            {
                "role": "assistant",
                "content": [{"text": "Resposta simulada."}],
            }
        ]

        self.contexto_agente = MagicMock()
        self.contexto_agente.__aenter__ = AsyncMock(
            return_value=self.instancia
        )
        self.contexto_agente.__aexit__ = AsyncMock(
            return_value=False
        )

        patch_agente = patch.object(
            runtime,
            "criar_agente",
            return_value=self.contexto_agente,
        )
        self.criar_agente = patch_agente.start()
        self.addCleanup(patch_agente.stop)

    def payload(self):
        return {
            "mensagem": "Liste os eventos.",
            "contexto": {"usuario_id": "usuario-autenticado"},
            "historico": [],
        }

    async def test_encaminha_identidade_e_configuracao_do_backend(self):
        payload = self.payload()
        payload["usuario_id"] = "usuario-forjado"

        resultado = await runtime.processar_requisicao(payload)

        argumentos = self.criar_agente.call_args.kwargs

        self.assertEqual(
            argumentos["usuario_id"],
            "usuario-autenticado",
        )
        self.assertEqual(
            argumentos["funcoes"],
            {
                "listar_catalogo": "lambda-listar",
                "registrar_intencao": "lambda-registrar",
                "realizar_compra": "lambda-comprar",
            },
        )
        self.assertNotIn("perfil_aws", argumentos)

        self.instancia.invoke_async.assert_awaited_once_with(
            "Liste os eventos."
        )
        self.assertEqual(resultado["resposta"], "Resposta simulada.")
        self.cliente_lambda.close.assert_called_once()

    async def test_identidade_apenas_no_payload_nao_e_aceita(self):
        payload = {
            "mensagem": "Liste os eventos.",
            "usuario_id": "usuario-forjado",
        }

        with self.assertRaises(ValueError):
            await runtime.processar_requisicao(payload)

        self.criar_cliente.assert_not_called()
        self.criar_agente.assert_not_called()

    async def test_entradas_invalidas_nao_criam_cliente(self):
        invalidos = [
            None,
            [],
            {},
            {**self.payload(), "mensagem": ""},
            {**self.payload(), "mensagem": {"text": "Olá"}},
            {**self.payload(), "contexto": {}},
            {**self.payload(), "historico": {}},
        ]

        for payload in invalidos:
            with self.subTest(payload=payload):
                with self.assertRaises(ValueError):
                    await runtime.processar_requisicao(payload)

        self.criar_cliente.assert_not_called()

    async def test_historico_retornado_e_uma_copia(self):
        original = deepcopy(self.instancia.messages)

        resultado = await runtime.processar_requisicao(self.payload())

        self.assertEqual(resultado["historico"], original)
        resultado["historico"][0]["content"][0]["text"] = "Alterado"

        self.assertEqual(self.instancia.messages, original)

    async def test_fecha_cliente_quando_modelo_falha(self):
        self.instancia.invoke_async.side_effect = RuntimeError(
            "Falha simulada."
        )

        with self.assertRaises(RuntimeError):
            await runtime.processar_requisicao(self.payload())

        self.cliente_lambda.close.assert_called_once()
        self.contexto_agente.__aexit__.assert_awaited_once()

    async def test_fecha_cliente_quando_montagem_falha(self):
        self.contexto_agente.__aenter__.side_effect = RuntimeError(
            "Falha na montagem."
        )

        with self.assertRaises(RuntimeError):
            await runtime.processar_requisicao(self.payload())

        self.cliente_lambda.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()