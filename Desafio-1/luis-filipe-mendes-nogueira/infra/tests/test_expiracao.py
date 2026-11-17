import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch
import boto3
from botocore.exceptions import ClientError
from botocore.stub import ANY, Stubber
import os

CAMINHO_MODULO = (
    Path(__file__).resolve().parents[2]
    / "tools"
    / "pagamentos"
    / "expiracao.py"
)

spec = importlib.util.spec_from_file_location(
    "expiracao_em_teste",
    CAMINHO_MODULO,
)

expiracao = importlib.util.module_from_spec(spec)
spec.loader.exec_module(expiracao)


def intencao(intencao_id="int_001"):
    return {
        "intencao_id": {"S": intencao_id},
        "evento_id": {"S": "evt_001"},
        "quantidade": {"N": "2"},
        "status": {"S": "pendente"},
        "expira_em_epoch": {"N": "900"},
    }


class TestExpiracao(unittest.TestCase):
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

    def executar(self):
        return expiracao.expirar_intencoes_vencidas(
            client=self.client,
            tabela_intencoes="intencoes-teste",
            tabela_catalogo="catalogo-teste",
            agora_epoch=1000,
        )

    def adicionar_falha_transacao(self, motivos):
        self.stubber.add_client_error(
            "transact_write_items",
            service_error_code="TransactionCanceledException",
            service_message="Transação cancelada.",
            modeled_fields={
                "CancellationReasons": motivos,
            },
            expected_params={"TransactItems": ANY},
        )

    def test_sem_vencidas_nao_altera_dados(self):
        self.stubber.add_response("query", {"Items": []})

        with patch.object(
            self.client,
            "transact_write_items",
            wraps=self.client.transact_write_items,
        ) as transacao:
            total = self.executar()

        self.assertEqual(total, 0)
        transacao.assert_not_called()
        self.stubber.assert_no_pending_responses()

    def test_expiracao_agrupa_status_e_estoque(self):
        self.stubber.add_response(
            "query",
            {"Items": [intencao()]},
        )
        self.stubber.add_response("transact_write_items", {})

        with patch.object(
            self.client,
            "transact_write_items",
            wraps=self.client.transact_write_items,
        ) as transacao:
            total = self.executar()

        self.assertEqual(total, 1)
        transacao.assert_called_once()

        operacoes = transacao.call_args.kwargs["TransactItems"]

        self.assertEqual(len(operacoes), 2)

        atualizacoes = {
            operacao["Update"]["TableName"]: operacao["Update"]
            for operacao in operacoes
        }

        self.assertEqual(
            atualizacoes["intencoes-teste"]["Key"],
            {"intencao_id": {"S": "int_001"}},
        )
        self.assertEqual(
            atualizacoes["catalogo-teste"]["Key"],
            {"evento_id": {"S": "evt_001"}},
        )

        # A mudança de status precisa ter proteção condicional.
        self.assertIn(
            "ConditionExpression",
            atualizacoes["intencoes-teste"],
        )

        self.stubber.assert_no_pending_responses()

    def test_intencao_ja_processada_nao_conta_nova_expiracao(self):
        self.stubber.add_response(
            "query",
            {"Items": [intencao()]},
        )

        self.adicionar_falha_transacao(
            [
                {"Code": "ConditionalCheckFailed"},
                {"Code": "None"},
            ]
        )

        total = self.executar()

        self.assertEqual(total, 0)
        self.stubber.assert_no_pending_responses()

    def test_evento_ausente_nao_e_ignorado(self):
        self.stubber.add_response(
            "query",
            {"Items": [intencao()]},
        )

        self.adicionar_falha_transacao(
            [
                {"Code": "None"},
                {"Code": "ConditionalCheckFailed"},
            ]
        )

        with self.assertRaises(ClientError):
            self.executar()

        self.stubber.assert_no_pending_responses()

    def test_processa_todas_as_paginas(self):
        ultima_chave = {
            "intencao_id": {"S": "int_001"},
            "status": {"S": "pendente"},
            "expira_em_epoch": {"N": "900"},
        }

        self.stubber.add_response(
            "query",
            {
                "Items": [intencao("int_001")],
                "LastEvaluatedKey": ultima_chave,
            },
        )
        self.stubber.add_response("transact_write_items", {})

        self.stubber.add_response(
            "query",
            {"Items": [intencao("int_002")]},
        )
        self.stubber.add_response("transact_write_items", {})

        with patch.object(
            self.client,
            "query",
            wraps=self.client.query,
        ) as consulta:
            total = self.executar()

        self.assertEqual(total, 2)
        self.assertEqual(consulta.call_count, 2)
        self.assertEqual(
            consulta.call_args_list[1].kwargs["ExclusiveStartKey"],
            ultima_chave,
        )

        self.stubber.assert_no_pending_responses()


if __name__ == "__main__":
    unittest.main()