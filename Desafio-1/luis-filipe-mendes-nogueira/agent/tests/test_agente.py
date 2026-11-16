import unittest
from copy import deepcopy
from unittest.mock import MagicMock, patch

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

        self.sessao = MagicMock()
        self.sessao.client.return_value = self.client_modelo

        patch_sessao = patch.object(
            agente.boto3,
            "Session",
            return_value=self.sessao,
        )
        self.construir_sessao = patch_sessao.start()
        self.addCleanup(patch_sessao.stop)

    def criar(self, historico=None, usuario_id="usuario-autenticado"):
        return agente.criar_agente(
            client_lambda=self.client_lambda,
            usuario_id=usuario_id,
            funcoes=FUNCOES,
            historico=historico,
            perfil_aws="luisfilipe",
        )

    async def test_configura_haiku_runtime_sem_invocar_servicos(self):
        async with self.criar() as instancia:
            self.construir_sessao.assert_called_once_with(
                profile_name="luisfilipe",
                region_name="us-east-1",
            )

            self.assertEqual(
                instancia.model.get_config()["model_id"],
                "us.anthropic.claude-haiku-4-5-20251001-v1:0",
            )
            self.assertEqual(
                instancia.model.get_config()["max_tokens"],
                1024,
            )
            self.assertIsInstance(
                instancia.conversation_manager,
                NullConversationManager,
            )

            chamada = self.sessao.client.call_args
            servico = (
                chamada.args[0]
                if chamada.args
                else chamada.kwargs["service_name"]
            )
            self.assertEqual(servico, "bedrock-runtime")

            self.client_modelo.converse.assert_not_called()
            self.client_modelo.converse_stream.assert_not_called()
            self.client_lambda.invoke.assert_not_called()

        self.client_modelo.close.assert_called_once()

    async def test_sem_perfil_usa_credenciais_do_ambiente(self):
        async with agente.criar_agente(
            client_lambda=self.client_lambda,
            usuario_id="usuario-autenticado",
            funcoes=FUNCOES,
        ):
            self.construir_sessao.assert_called_once_with(
                profile_name=None,
                region_name="us-east-1",
            )

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

        self.client_modelo.close.assert_called_once()

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

        self.client_modelo.close.assert_called_once()

    async def test_historico_invalido_e_recusado_antes_da_sessao(self):
        with self.assertRaises(ValueError):
            async with self.criar(historico={"messages": []}):
                self.fail("Histórico inválido foi aceito.")

        self.construir_sessao.assert_not_called()
        self.client_lambda.invoke.assert_not_called()


if __name__ == "__main__":
    unittest.main()