import unittest
from copy import deepcopy
from unittest.mock import AsyncMock, MagicMock, patch

import agente
from strands.agent.conversation_manager import NullConversationManager


FUNCOES = {
    "listar_catalogo": "lambda-listar-teste",
    "registrar_intencao": "lambda-registrar-teste",
    "realizar_compra": "lambda-comprar-teste",
}


class TestAgente(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.client_lambda = MagicMock()
        self.client_modelo = MagicMock()

        self.contexto_cliente = MagicMock()
        self.contexto_cliente.__aenter__ = AsyncMock(
            return_value=self.client_modelo
        )
        self.contexto_cliente.__aexit__ = AsyncMock(
            return_value=False
        )

        patch_cliente = patch.object(
            agente,
            "AsyncAnthropicBedrockMantle",
            return_value=self.contexto_cliente,
        )
        self.construir_cliente = patch_cliente.start()
        self.addCleanup(patch_cliente.stop)

    def criar(self, historico=None, usuario_id="usuario-autenticado"):
        return agente.criar_agente(
            client_lambda=self.client_lambda,
            usuario_id=usuario_id,
            funcoes=FUNCOES,
            historico=historico,
            perfil_aws="luisfilipe",
        )

    async def test_configura_haiku_regional_sem_invocar_servicos(self):
        async with self.criar() as instancia:
            argumentos = self.construir_cliente.call_args.kwargs

            self.assertEqual(argumentos["aws_region"], "us-east-1")
            self.assertEqual(argumentos["aws_profile"], "luisfilipe")
            self.assertEqual(
                argumentos["base_url"],
                "https://bedrock-mantle.us-east-1.api.aws/anthropic",
            )
            self.assertEqual(
                instancia.model.get_config()["model_id"],
                "anthropic.claude-haiku-4-5",
            )
            self.assertIsInstance(
                instancia.conversation_manager,
                NullConversationManager,
            )

            self.client_modelo.messages.create.assert_not_called()
            self.client_lambda.invoke.assert_not_called()

        self.contexto_cliente.__aexit__.assert_awaited_once()

    async def test_historico_e_copiado_sem_perder_mensagens(self):
        historico = [
            {
                "role": "user",
                "content": [{"text": "Quais eventos estão disponíveis?"}],
            },
            {
                "role": "assistant",
                "content": [{"text": "Posso consultar o catálogo."}],
            },
        ]
        original = deepcopy(historico)

        async with self.criar(historico=historico) as instancia:
            self.assertEqual(instancia.messages, original)
            self.assertIsNot(instancia.messages, historico)

            instancia.messages[0]["content"][0]["text"] = "Texto alterado."
            instancia.messages.append(
                {
                    "role": "user",
                    "content": [{"text": "Outra mensagem."}],
                }
            )

        self.assertEqual(historico, original)

    async def test_execucoes_nao_compartilham_lista_de_mensagens(self):
        async with self.criar(usuario_id="usuario-a") as primeiro:
            primeiro.messages.append(
                {
                    "role": "user",
                    "content": [{"text": "Mensagem do usuário A."}],
                }
            )

        async with self.criar(usuario_id="usuario-b") as segundo:
            self.assertEqual(segundo.messages, [])
            self.assertIsNot(segundo.messages, primeiro.messages)

    async def test_fecha_cliente_quando_execucao_falha(self):
        with self.assertRaisesRegex(
            RuntimeError,
            "falha simulada durante execução",
        ):
            async with self.criar():
                raise RuntimeError(
                    "falha simulada durante execução"
                )

        self.contexto_cliente.__aexit__.assert_awaited_once()
        tipo_erro = self.contexto_cliente.__aexit__.await_args.args[0]
        self.assertIs(tipo_erro, RuntimeError)

    async def test_fecha_cliente_quando_montagem_do_agente_falha(self):
        with patch.object(
            agente,
            "Agent",
            side_effect=RuntimeError("falha simulada na montagem"),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "falha simulada na montagem",
            ):
                async with self.criar():
                    self.fail("O agente não deveria ter sido criado.")

        self.contexto_cliente.__aexit__.assert_awaited_once()

    async def test_historico_invalido_e_recusado_antes_do_cliente(self):
        with self.assertRaises(ValueError):
            async with self.criar(historico={"messages": []}):
                self.fail("Histórico inválido foi aceito.")

        self.construir_cliente.assert_not_called()
        self.client_lambda.invoke.assert_not_called()


if __name__ == "__main__":
    unittest.main()