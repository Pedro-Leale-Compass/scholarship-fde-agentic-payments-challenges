import importlib.util
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import boto3
from botocore.stub import Stubber


PASTA_TOOLS = (
    Path(__file__).resolve().parents[2]
    / "tools"
    / "pagamentos"
)

spec = importlib.util.spec_from_file_location(
    "listar_catalogo_em_teste",
    PASTA_TOOLS / "listar_catalogo.py",
)

catalogo = importlib.util.module_from_spec(spec)

# Permite carregar os módulos irmãos, como acontece na Lambda.
with patch.object(sys, "path", [str(PASTA_TOOLS), *sys.path]):
    spec.loader.exec_module(catalogo)


def evento():
    return {
        "evento_id": {"S": "evt_001"},
        "nome": {"S": "Workshop de teste"},
        "categoria_normalizada": {"S": "workshop"},
        "preco_centavos": {"N": "12025"},
        "moeda": {"S": "BRL"},
        "vagas_restantes": {"N": "8"},
    }


class TestListarCatalogo(unittest.TestCase):
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
            catalogo,
            "expirar_intencoes_vencidas",
            return_value=0,
        )
        self.limpeza = patch_limpeza.start()
        self.addCleanup(patch_limpeza.stop)

    def executar(self, categoria=None):
        return catalogo.listar_catalogo(
            client=self.client,
            tabela_catalogo="catalogo-teste",
            tabela_intencoes="intencoes-teste",
            categoria=categoria,
            agora_epoch=1000,
        )

    def test_preserva_contrato_e_converte_centavos(self):
        self.stubber.add_response(
            "scan",
            {"Items": [evento()]},
        )

        resultado = self.executar()

        self.assertEqual(
            resultado,
            {
                "produtos": [
                    {
                        "id": "evt_001",
                        "nome": "Workshop de teste",
                        "preco": 120.25,
                        "moeda": "BRL",
                        "estoque": 8,
                    }
                ]
            },
        )

        self.limpeza.assert_called_once_with(
            client=self.client,
            tabela_intencoes="intencoes-teste",
            tabela_catalogo="catalogo-teste",
            agora_epoch=1000,
        )

        self.stubber.assert_no_pending_responses()

    def test_categoria_e_normalizada(self):
        self.stubber.add_response(
            "scan",
            {"Items": [evento()]},
            expected_params={
                "TableName": "catalogo-teste",
                "ConsistentRead": True,
                "FilterExpression": "#categoria = :categoria",
                "ExpressionAttributeNames": {
                    "#categoria": "categoria_normalizada",
                },
                "ExpressionAttributeValues": {
                    ":categoria": {"S": "workshop"},
                },
            },
        )

        resultado = self.executar("WoRkShOp")

        self.assertEqual(len(resultado["produtos"]), 1)
        self.stubber.assert_no_pending_responses()

    def test_catalogo_vazio_e_retorno_valido(self):
        self.stubber.add_response("scan", {"Items": []})

        resultado = self.executar()

        self.assertEqual(resultado, {"produtos": []})
        self.stubber.assert_no_pending_responses()

    def test_pagina_vazia_com_chave_continua_consulta(self):
        ultima_chave = {"evento_id": {"S": "evt_000"}}

        self.stubber.add_response(
            "scan",
            {
                "Items": [],
                "LastEvaluatedKey": ultima_chave,
            },
            expected_params={
                "TableName": "catalogo-teste",
                "ConsistentRead": True,
            },
        )

        self.stubber.add_response(
            "scan",
            {"Items": [evento()]},
            expected_params={
                "TableName": "catalogo-teste",
                "ConsistentRead": True,
                "ExclusiveStartKey": ultima_chave,
            },
        )

        resultado = self.executar()

        self.assertEqual(len(resultado["produtos"]), 1)
        self.assertEqual(resultado["produtos"][0]["id"], "evt_001")
        self.stubber.assert_no_pending_responses()

    def test_falha_na_expiracao_interrompe_listagem(self):
        self.limpeza.side_effect = RuntimeError(
            "Falha simulada na expiração."
        )

        with patch.object(
            self.client,
            "scan",
            wraps=self.client.scan,
        ) as consulta:
            with self.assertRaises(RuntimeError):
                self.executar()

        consulta.assert_not_called()

    def test_handler_nao_aceita_identidade_apenas_nos_argumentos(self):
        evento_recebido = {
            "argumentos": {
                "categoria": "Workshop",
                "usuario_id": "identidade-enviada-pelo-modelo",
            }
        }

        with (
            patch.object(catalogo.boto3, "client") as criar_cliente,
            self.assertLogs(catalogo.logger, level="ERROR"),
        ):
            resultado = catalogo.handler(evento_recebido, None)

        self.assertEqual(resultado["status"], "recusado")
        self.assertEqual(resultado["erro"], "ERRO_INTERNO")
        criar_cliente.assert_not_called()

    def test_handler_nao_expoe_detalhes_da_falha(self):
        evento_recebido = {
            "argumentos": {},
            "contexto": {
                "usuario_id": "usuario-autenticado",
            },
        }

        with (
            patch.object(
                catalogo.boto3,
                "client",
                side_effect=RuntimeError("detalhe-interno-simulado"),
            ),
            self.assertLogs(catalogo.logger, level="ERROR"),
        ):
            resultado = catalogo.handler(evento_recebido, None)

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
        self.assertNotIn("detalhe-interno-simulado", str(resultado))


if __name__ == "__main__":
    unittest.main()