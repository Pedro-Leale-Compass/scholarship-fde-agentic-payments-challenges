import importlib.util
import json
import os
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError


CAMINHO_HANDLER = (
    Path(__file__).resolve().parents[2]
    / "api"
    / "perfil"
    / "handler.py"
)

spec = importlib.util.spec_from_file_location(
    "perfil_handler_em_teste",
    CAMINHO_HANDLER,
)

perfil = importlib.util.module_from_spec(spec)

# Evita criar um cliente AWS real durante a importação.
with (
    patch.dict(os.environ, {"USUARIOS_TABLE": "usuarios-teste"}),
    patch("boto3.resource"),
):
    spec.loader.exec_module(perfil)


class TestPerfil(unittest.TestCase):
    def setUp(self):
        self.tabela = MagicMock()
        self.patch_tabela = patch.object(
            perfil,
            "tabela",
            self.tabela,
        )
        self.patch_tabela.start()
        self.addCleanup(self.patch_tabela.stop)

        self.evento = {
            "requestContext": {
                "authorizer": {
                    "jwt": {
                        "claims": {
                            "sub": "usuario-autenticado",
                            "username": "nome-autenticado",
                        }
                    }
                }
            }
        }

    def consultar(self, evento=None):
        resposta = perfil.handler(
            self.evento if evento is None else evento,
            None,
        )
        return resposta["statusCode"], json.loads(resposta["body"])

    def test_primeiro_acesso_cria_limite_inicial(self):
        self.tabela.get_item.return_value = {}

        status, dados = self.consultar()

        self.assertEqual(status, 200)
        self.assertEqual(dados["id"], "usuario-autenticado")
        self.assertEqual(dados["limiteGasto"], 500)

        self.tabela.put_item.assert_called_once()
        argumentos = self.tabela.put_item.call_args.kwargs

        self.assertEqual(
            argumentos["Item"]["limite_centavos"],
            50000,
        )
        self.assertEqual(
            argumentos["ConditionExpression"],
            "attribute_not_exists(usuario_id)",
        )

    def test_perfil_existente_preserva_limite_gasto(self):
        self.tabela.get_item.return_value = {
            "Item": {
                "usuario_id": "usuario-autenticado",
                "username": "nome-salvo",
                "limite_centavos": 37525,
            }
        }

        status, dados = self.consultar()

        self.assertEqual(status, 200)
        self.assertEqual(dados["limiteGasto"], 375.25)
        self.tabela.put_item.assert_not_called()

    def test_criacao_concorrente_retorna_perfil_vencedor(self):
        self.tabela.get_item.side_effect = [
            {},
            {
                "Item": {
                    "usuario_id": "usuario-autenticado",
                    "username": "nome-salvo",
                    "limite_centavos": 20000,
                }
            },
        ]

        self.tabela.put_item.side_effect = ClientError(
            {
                "Error": {
                    "Code": "ConditionalCheckFailedException",
                    "Message": "O perfil já foi criado.",
                }
            },
            "PutItem",
        )

        status, dados = self.consultar()

        self.assertEqual(status, 200)
        self.assertEqual(dados["limiteGasto"], 200)
        self.assertEqual(self.tabela.get_item.call_count, 2)
        self.tabela.put_item.assert_called_once()

    def test_identidade_do_corpo_nao_substitui_claims(self):
        self.tabela.get_item.return_value = {
            "Item": {
                "usuario_id": "usuario-autenticado",
                "username": "nome-salvo",
                "limite_centavos": 50000,
            }
        }

        evento = {
            **self.evento,
            "body": json.dumps({"usuario_id": "outro-usuario"}),
            "queryStringParameters": {
                "usuario_id": "outro-usuario",
            },
        }

        status, dados = self.consultar(evento)

        self.assertEqual(status, 200)
        self.assertEqual(dados["id"], "usuario-autenticado")

        self.tabela.get_item.assert_called_once_with(
            Key={"usuario_id": "usuario-autenticado"},
            ConsistentRead=True,
        )

    def test_sem_claims_recusa_sem_acessar_banco(self):
        status, _ = self.consultar(
            {"body": json.dumps({"usuario_id": "usuario-forjado"})}
        )

        self.assertEqual(status, 401)
        self.tabela.get_item.assert_not_called()
        self.tabela.put_item.assert_not_called()


if __name__ == "__main__":
    unittest.main()