import importlib.util
import os
import unittest
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from botocore.stub import Stubber


CAMINHO_SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "seed_catalogo.py"
)

spec = importlib.util.spec_from_file_location(
    "seed_catalogo_em_teste",
    CAMINHO_SCRIPT,
)

seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)


class TestSeedCatalogo(unittest.TestCase):
    def setUp(self):
        with patch_ambiente_aws():
            sessao = boto3.Session(
                region_name="us-east-1",
                aws_access_key_id="teste",
                aws_secret_access_key="teste",
            )
            self.client = sessao.client("dynamodb")

        self.stubber = Stubber(self.client)
        self.stubber.activate()
        self.addCleanup(self.stubber.deactivate)

        self.evento = {
            "evento_id": "evt_001",
            "nome": "Workshop de teste",
            "categoria": "Workshop",
            "categoria_normalizada": "workshop",
            "preco_centavos": 12000,
            "moeda": "BRL",
            "vagas_totais": 30,
            "vagas_restantes": 30,
        }

        self.parametros = {
            "TableName": "catalogo-teste",
            "Item": {
                "evento_id": {"S": "evt_001"},
                "nome": {"S": "Workshop de teste"},
                "categoria": {"S": "Workshop"},
                "categoria_normalizada": {"S": "workshop"},
                "preco_centavos": {"N": "12000"},
                "moeda": {"S": "BRL"},
                "vagas_totais": {"N": "30"},
                "vagas_restantes": {"N": "30"},
            },
            "ConditionExpression": (
                "attribute_not_exists(evento_id)"
            ),
        }

    def executar(self):
        return seed.popular_catalogo(
            client=self.client,
            tabela_catalogo="catalogo-teste",
            eventos=[self.evento],
        )

    def test_evento_novo_e_criado_com_condicao(self):
        self.stubber.add_response(
            "put_item",
            {},
            expected_params=self.parametros,
        )

        resultado = self.executar()

        self.assertEqual(
            resultado,
            {"criados": 1, "existentes": 0},
        )
        self.stubber.assert_no_pending_responses()

    def test_evento_existente_nao_e_sobrescrito(self):
        self.stubber.add_client_error(
            "put_item",
            service_error_code="ConditionalCheckFailedException",
            service_message="Evento já existe.",
            expected_params=self.parametros,
        )

        resultado = self.executar()

        self.assertEqual(
            resultado,
            {"criados": 0, "existentes": 1},
        )
        self.stubber.assert_no_pending_responses()

    def test_falha_de_permissao_nao_e_ignorada(self):
        self.stubber.add_client_error(
            "put_item",
            service_error_code="AccessDeniedException",
            service_message="Sem permissão.",
            expected_params=self.parametros,
        )

        with self.assertRaises(ClientError) as captura:
            self.executar()

        self.assertEqual(
            captura.exception.response["Error"]["Code"],
            "AccessDeniedException",
        )
        self.stubber.assert_no_pending_responses()


def patch_ambiente_aws():
    from contextlib import contextmanager
    from unittest.mock import patch

    @contextmanager
    def ambiente_isolado():
        with patch.dict(
            os.environ,
            {
                "AWS_CONFIG_FILE": os.devnull,
                "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
            },
        ):
            os.environ.pop("AWS_PROFILE", None)
            os.environ.pop("AWS_DEFAULT_PROFILE", None)
            yield

    return ambiente_isolado()


if __name__ == "__main__":
    unittest.main()