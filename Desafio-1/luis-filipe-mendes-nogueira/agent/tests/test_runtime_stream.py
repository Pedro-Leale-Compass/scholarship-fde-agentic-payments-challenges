import json
import unittest
from copy import deepcopy
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

import runtime


VARIAVEIS = {
    "LISTAR_CATALOGO_FUNCTION": "lambda-listar",
    "REGISTRAR_INTENCAO_FUNCTION": "lambda-registrar",
    "REALIZAR_COMPRA_FUNCTION": "lambda-comprar",
}


class TestRuntimeStream(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        patch_env = patch.dict(runtime.os.environ, VARIAVEIS)
        patch_env.start()
        self.addCleanup(patch_env.stop)

        self.cliente = MagicMock()
        patch_cliente = patch.object(
            runtime.boto3,
            "client",
            return_value=self.cliente,
        )
        self.criar_cliente = patch_cliente.start()
        self.addCleanup(patch_cliente.stop)

        self.instancia = MagicMock()
        self.instancia.messages = [
            {
                "role": "user",
                "content": [{"text": "Olá."}],
            },
            {
                "role": "assistant",
                "content": [{"text": "Olá!"}],
            },
        ]

        self.contexto = MagicMock()
        self.contexto.__aenter__ = AsyncMock(
            return_value=self.instancia
        )
        self.contexto.__aexit__ = AsyncMock(
            return_value=False
        )

        patch_agente = patch.object(
            runtime,
            "criar_agente",
            return_value=self.contexto,
        )
        self.criar_agente = patch_agente.start()
        self.addCleanup(patch_agente.stop)

        self.fluxo_fechado = False
        self.fluxo_terminado = False

        self.configurar_eventos(
            {"data": "Olá"},
            {"data": "!"},
            {"message": self.instancia.messages[-1]},
            {"result": "Olá!"},
        )

    def payload(self):
        return {
            "mensagem": "Olá.",
            "contexto": {"usuario_id": "usuario-autenticado"},
            "historico": [],
            "stream": True,
        }

    def configurar_eventos(self, *eventos, falha=None):
        async def gerar():
            try:
                for evento in eventos:
                    yield evento

                if falha is not None:
                    raise falha

                self.fluxo_terminado = True
            finally:
                self.fluxo_fechado = True

        self.instancia.stream_async.side_effect = (
            lambda mensagem: gerar()
        )

    async def test_envia_delta_antes_de_terminar(self):
        payload = self.payload()
        payload["usuario_id"] = "usuario-forjado"

        fluxo = runtime.processar_stream(payload)
        primeiro = await anext(fluxo)

        self.assertEqual(
            primeiro,
            {"tipo": "delta", "texto": "Olá"},
        )
        self.assertFalse(self.fluxo_terminado)

        restantes = [evento async for evento in fluxo]

        self.assertEqual(
            restantes[-1]["tipo"],
            "fim",
        )
        self.assertEqual(
            restantes[-1]["resposta"],
            "Olá!",
        )
        self.assertEqual(
            restantes[-1]["historico"],
            self.instancia.messages,
        )
        self.assertTrue(
            any(e["tipo"] == "mensagem" for e in restantes)
        )

        argumentos = self.criar_agente.call_args.kwargs
        self.assertEqual(
            argumentos["usuario_id"],
            "usuario-autenticado",
        )

        restantes[-1]["historico"].clear()
        self.assertTrue(self.instancia.messages)

        self.assertTrue(self.fluxo_fechado)
        self.cliente.close.assert_called_once()

    async def test_entrada_invalida_nao_cria_cliente(self):
        eventos = [
            evento
            async for evento in runtime.processar_stream(
                {"mensagem": "Olá.", "stream": True}
            )
        ]

        self.assertEqual(len(eventos), 1)
        self.assertEqual(
            eventos[0]["erro"],
            "PAYLOAD_INVALIDO",
        )
        self.criar_cliente.assert_not_called()
        self.criar_agente.assert_not_called()

    async def test_stream_deve_ser_booleano(self):
        payload = self.payload()
        payload["stream"] = "true"

        resultado = await runtime.executar(payload)

        self.assertEqual(
            resultado["erro"],
            "PAYLOAD_INVALIDO",
        )
        self.criar_cliente.assert_not_called()

    async def test_falha_nao_expoe_detalhes(self):
        self.configurar_eventos(
            {"data": "Texto parcial"},
            falha=RuntimeError("detalhe-interno-sensivel"),
        )
        original = deepcopy(self.instancia.messages)

        with self.assertLogs(runtime.logger, level="ERROR"):
            eventos = [
                evento
                async for evento in runtime.processar_stream(
                    self.payload()
                )
            ]

        self.assertEqual(eventos[0]["tipo"], "delta")
        self.assertEqual(eventos[-1]["tipo"], "erro")
        self.assertEqual(
            eventos[-1]["erro"],
            "ERRO_INTERNO",
        )
        self.assertEqual(
            eventos[-1]["historico"],
            original,
        )
        self.assertNotIn(
            "detalhe-interno-sensivel",
            json.dumps(eventos),
        )
        self.assertFalse(
            any(e["tipo"] == "fim" for e in eventos)
        )

        self.cliente.close.assert_called_once()
        self.contexto.__aexit__.assert_awaited_once()

    async def test_sem_resultado_final_nao_emite_fim(self):
        self.configurar_eventos({"data": "Parcial"})

        with self.assertLogs(runtime.logger, level="ERROR"):
            eventos = [
                evento
                async for evento in runtime.processar_stream(
                    self.payload()
                )
            ]

        self.assertEqual(eventos[-1]["tipo"], "erro")
        self.assertFalse(
            any(e["tipo"] == "fim" for e in eventos)
        )

    async def test_cancelamento_fecha_clientes(self):
        fluxo = runtime.processar_stream(self.payload())

        primeiro = await anext(fluxo)
        self.assertEqual(primeiro["tipo"], "delta")

        await fluxo.aclose()

        self.assertTrue(self.fluxo_fechado)
        self.cliente.close.assert_called_once()
        self.contexto.__aexit__.assert_awaited_once()

    async def test_http_json_continua_disponivel(self):
        esperado = {"resposta": "OK", "historico": []}
        payload = self.payload()
        payload.pop("stream")

        with patch.object(
            runtime,
            "processar_requisicao",
            new=AsyncMock(return_value=esperado),
        ):
            transporte = httpx.ASGITransport(app=runtime.app)

            async with httpx.AsyncClient(
                transport=transporte,
                base_url="http://teste",
            ) as cliente_http:
                resposta = await cliente_http.post(
                    "/invocations",
                    json=payload,
                )

        self.assertEqual(resposta.status_code, 200)
        self.assertTrue(
            resposta.headers["content-type"].startswith(
                "application/json"
            )
        )
        self.assertEqual(resposta.json(), esperado)

    async def test_http_stream_usa_sse(self):
        esperado = {
            "tipo": "fim",
            "resposta": "OK",
            "historico": [],
        }

        async def gerar():
            yield esperado

        with patch.object(
            runtime,
            "processar_stream",
            return_value=gerar(),
        ):
            transporte = httpx.ASGITransport(app=runtime.app)

            async with httpx.AsyncClient(
                transport=transporte,
                base_url="http://teste",
            ) as cliente_http:
                resposta = await cliente_http.post(
                    "/invocations",
                    json=self.payload(),
                )

        self.assertEqual(resposta.status_code, 200)
        self.assertTrue(
            resposta.headers["content-type"].startswith(
                "text/event-stream"
            )
        )

        eventos = [
            json.loads(linha.removeprefix("data:").strip())
            for linha in resposta.text.splitlines()
            if linha.startswith("data:")
            and linha.removeprefix("data:").strip() != "[DONE]"
        ]

        self.assertIn(esperado, eventos)


if __name__ == "__main__":
    unittest.main()