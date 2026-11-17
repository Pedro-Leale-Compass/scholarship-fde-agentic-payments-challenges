import importlib.util
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import boto3
from botocore.exceptions import ClientError
from botocore.stub import ANY, Stubber


PASTA_TOOLS = (
    Path(__file__).resolve().parents[2]
    / "tools"
    / "pagamentos"
)

spec = importlib.util.spec_from_file_location(
    "registrar_intencao_em_teste",
    PASTA_TOOLS / "registrar_intencao.py",
)

registro = importlib.util.module_from_spec(spec)

with patch.object(sys, "path", [str(PASTA_TOOLS), *sys.path]):
    spec.loader.exec_module(registro)


def evento(estoque=10, preco=12025):
    return {
        "evento_id": {"S": "evt_001"},
        "preco_centavos": {"N": str(preco)},
        "moeda": {"S": "BRL"},
        "vagas_restantes": {"N": str(estoque)},
    }


class TestRegistrarIntencao(unittest.TestCase):
    def setUp(self):
        with patch.dict(
            os.environ,
            {
                "AWS_CONFIG_FILE": os.devnull,
                "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
            },
        ):
            os.environ.pop("AWS_PROFILE", None)
            os.environ.pop("AWS_DEFAULT_PROFILE", None)

            sessao = boto3.Session(
                region_name="us-east-1",
                aws_access_key_id="teste",
                aws_secret_access_key="teste",
            )

            self.client = sessao.client("dynamodb")

        self.stubber = Stubber(self.client)
        self.stubber.activate()
        self.addCleanup(self.stubber.deactivate)

        patch_limpeza = patch.object(
            registro,
            "expirar_intencoes_vencidas",
            return_value=0,
        )
        self.limpeza = patch_limpeza.start()
        self.addCleanup(patch_limpeza.stop)

    def executar(self, quantidade=2):
        return registro.registrar_intencao(
            client=self.client,
            tabela_catalogo="catalogo-teste",
            tabela_intencoes="intencoes-teste",
            usuario_id="usuario-autenticado",
            evento_id="evt_001",
            quantidade=quantidade,
            agora_epoch=1000,
        )

    def adicionar_consulta(self, item):
        self.stubber.add_response(
            "get_item",
            {"Item": item} if item is not None else {},
            expected_params={
                "TableName": "catalogo-teste",
                "Key": {"evento_id": {"S": "evt_001"}},
                "ConsistentRead": True,
            },
        )

    def adicionar_recusa(self, motivos):
        self.stubber.add_client_error(
            "transact_write_items",
            service_error_code="TransactionCanceledException",
            service_message="Transação cancelada.",
            modeled_fields={"CancellationReasons": motivos},
            expected_params={
                "ClientRequestToken": ANY,
                "TransactItems": ANY,
            },
        )

    def test_quantidade_invalida_nao_acessa_banco(self):
        for quantidade in [0, -1, 1.5, True, "2", None]:
            with self.subTest(quantidade=quantidade):
                with patch.object(self.client, "get_item") as consulta:
                    with self.assertRaises(ValueError):
                        self.executar(quantidade)

                consulta.assert_not_called()

        self.limpeza.assert_not_called()

    def test_evento_inexistente_recusa_sem_reservar(self):
        self.adicionar_consulta(None)

        with patch.object(
            self.client,
            "transact_write_items",
        ) as transacao:
            resultado = self.executar()

        self.assertEqual(resultado["erro"], "INTENCAO_INVALIDA")
        transacao.assert_not_called()
        self.stubber.assert_no_pending_responses()

    def test_estoque_insuficiente_recusa_sem_reservar(self):
        self.adicionar_consulta(evento(estoque=1))

        with patch.object(
            self.client,
            "transact_write_items",
        ) as transacao:
            resultado = self.executar()

        self.assertEqual(resultado["erro"], "VAGAS_INSUFICIENTES")
        transacao.assert_not_called()
        self.stubber.assert_no_pending_responses()

    def test_sucesso_calcula_valor_e_agrupa_as_escritas(self):
        self.adicionar_consulta(evento())
        self.stubber.add_response("transact_write_items", {})

        with patch.object(
            self.client,
            "transact_write_items",
            wraps=self.client.transact_write_items,
        ) as transacao:
            resultado = self.executar()

        self.assertEqual(resultado["valorTotal"], 240.50)
        self.assertEqual(resultado["quantidade"], 2)
        self.assertEqual(resultado["usuarioId"], "usuario-autenticado")
        self.assertEqual(resultado["status"], "pendente")
        self.assertEqual(
            resultado["expiraEm"],
            "1970-01-01T00:21:40Z",
        )

        transacao.assert_called_once()
        argumentos = transacao.call_args.kwargs
        operacoes = argumentos["TransactItems"]

        self.assertEqual(len(operacoes), 2)
        self.assertEqual(
            argumentos["ClientRequestToken"],
            resultado["intencaoId"],
        )

        reserva = operacoes[0]["Update"]
        gravacao = operacoes[1]["Put"]

        self.assertEqual(reserva["TableName"], "catalogo-teste")
        self.assertEqual(gravacao["TableName"], "intencoes-teste")
        self.assertEqual(
            gravacao["Item"]["valor_total_centavos"],
            {"N": "24050"},
        )
        self.assertEqual(
            gravacao["Item"]["expira_em_epoch"],
            {"N": "1300"},
        )
        self.assertEqual(
            gravacao["Item"]["intencao_id"],
            {"S": resultado["intencaoId"]},
        )

        self.stubber.assert_no_pending_responses()

    def test_estoque_esgotado_por_outra_compra(self):
        self.adicionar_consulta(evento(estoque=10))
        self.adicionar_recusa(
            [
                {"Code": "ConditionalCheckFailed"},
                {"Code": "None"},
            ]
        )
        self.adicionar_consulta(evento(estoque=1))

        resultado = self.executar()

        self.assertEqual(resultado["erro"], "VAGAS_INSUFICIENTES")
        self.stubber.assert_no_pending_responses()

    def test_preco_alterado_nao_retorna_intencao_aprovada(self):
        self.adicionar_consulta(evento(preco=12025))
        self.adicionar_recusa(
            [
                {"Code": "ConditionalCheckFailed"},
                {"Code": "None"},
            ]
        )
        self.adicionar_consulta(evento(preco=15000))

        with self.assertLogs(registro.logger, level="WARNING"):
            resultado = self.executar()

        self.assertEqual(resultado["erro"], "ERRO_INTERNO")
        self.assertNotIn("intencaoId", resultado)
        self.stubber.assert_no_pending_responses()

    def test_colisao_de_id_nao_e_confundida_com_falta_de_vagas(self):
        self.adicionar_consulta(evento())
        self.adicionar_recusa(
            [
                {"Code": "None"},
                {"Code": "ConditionalCheckFailed"},
            ]
        )

        with self.assertRaises(ClientError):
            self.executar()

        self.stubber.assert_no_pending_responses()

    def test_handler_exige_contexto_separado(self):
        evento_recebido = {
            "argumentos": {
                "evento_id": "evt_001",
                "quantidade": 2,
                "usuario_id": "usuario-forjado",
            }
        }

        with (
            patch.object(registro.boto3, "client") as criar_cliente,
            patch.object(registro, "registrar_intencao") as executar,
            self.assertLogs(registro.logger, level="ERROR"),
        ):
            resultado = registro.handler(evento_recebido, None)

        self.assertEqual(resultado["erro"], "ERRO_INTERNO")
        criar_cliente.assert_not_called()
        executar.assert_not_called()

    def test_handler_ignora_usuario_e_valor_dos_argumentos(self):
        evento_recebido = {
            "argumentos": {
                "evento_id": "evt_001",
                "quantidade": 2,
                "usuario_id": "usuario-forjado",
                "valorTotal": 0.01,
                "valor_total_centavos": 1,
            },
            "contexto": {
                "usuario_id": "usuario-autenticado",
            },
        }

        retorno_esperado = {"intencaoId": "int_teste"}

        with (
            patch.dict(
                os.environ,
                {
                    "CATALOGO_TABLE": "catalogo-teste",
                    "INTENCOES_TABLE": "intencoes-teste",
                },
            ),
            patch.object(
                registro.boto3,
                "client",
                return_value=self.client,
            ),
            patch.object(
                registro,
                "registrar_intencao",
                return_value=retorno_esperado,
            ) as executar,
        ):
            resultado = registro.handler(evento_recebido, None)

        executar.assert_called_once_with(
            client=self.client,
            tabela_catalogo="catalogo-teste",
            tabela_intencoes="intencoes-teste",
            usuario_id="usuario-autenticado",
            evento_id="evt_001",
            quantidade=2,
        )

        self.assertEqual(resultado, retorno_esperado)


if __name__ == "__main__":
    unittest.main()