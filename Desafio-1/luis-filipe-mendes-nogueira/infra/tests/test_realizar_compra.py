import importlib.util
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import boto3
from botocore.stub import ANY, Stubber


PASTA_TOOLS = (
    Path(__file__).resolve().parents[2]
    / "tools"
    / "pagamentos"
)

spec = importlib.util.spec_from_file_location(
    "realizar_compra_em_teste",
    PASTA_TOOLS / "realizar_compra.py",
)

compra = importlib.util.module_from_spec(spec)

with patch.object(sys, "path", [str(PASTA_TOOLS), *sys.path]):
    spec.loader.exec_module(compra)


def intencao(
    usuario="usuario-autenticado",
    status="pendente",
    expiracao=2000,
):
    return {
        "intencao_id": {"S": "int_001"},
        "usuario_id": {"S": usuario},
        "evento_id": {"S": "evt_001"},
        "quantidade": {"N": "1"},
        "valor_total_centavos": {"N": "12000"},
        "moeda": {"S": "BRL"},
        "status": {"S": status},
        "expira_em_epoch": {"N": str(expiracao)},
    }


class TestRealizarCompra(unittest.TestCase):
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

        patch_expiracao = patch.object(
            compra,
            "expirar_intencao",
            return_value=True,
        )
        self.expirar = patch_expiracao.start()
        self.addCleanup(patch_expiracao.stop)

    def executar(self, metodo="cartao"):
        return compra.realizar_compra(
            client=self.client,
            tabela_usuarios="usuarios-teste",
            tabela_intencoes="intencoes-teste",
            tabela_transacoes="transacoes-teste",
            tabela_catalogo="catalogo-teste",
            usuario_id="usuario-autenticado",
            intencao_id="int_001",
            metodo_pagamento=metodo,
            agora_epoch=1000,
        )

    def consultar_intencao(self, item):
        self.stubber.add_response(
            "get_item",
            {"Item": item} if item is not None else {},
            expected_params={
                "TableName": "intencoes-teste",
                "Key": {"intencao_id": {"S": "int_001"}},
                "ConsistentRead": True,
            },
        )

    def consultar_usuario(self, limite=50000):
        self.stubber.add_response(
            "get_item",
            {
                "Item": {
                    "usuario_id": {"S": "usuario-autenticado"},
                    "limite_centavos": {"N": str(limite)},
                }
            },
            expected_params={
                "TableName": "usuarios-teste",
                "Key": {
                    "usuario_id": {"S": "usuario-autenticado"},
                },
                "ConsistentRead": True,
            },
        )

    def aprovar_transacao(self):
        self.stubber.add_response(
            "transact_write_items",
            {},
            expected_params={
                "ClientRequestToken": ANY,
                "TransactItems": ANY,
            },
        )

    def recusar_transacao(self, codigos):
        self.stubber.add_client_error(
            "transact_write_items",
            service_error_code="TransactionCanceledException",
            service_message="Transação cancelada.",
            modeled_fields={
                "CancellationReasons": [
                    {"Code": codigo}
                    for codigo in codigos
                ]
            },
            expected_params={
                "ClientRequestToken": ANY,
                "TransactItems": ANY,
            },
        )

    def test_aprova_cartao_e_pix_com_valor_da_intencao(self):
        for metodo in ("cartao", "pix"):
            with self.subTest(metodo=metodo):
                self.consultar_intencao(intencao())
                self.consultar_usuario()
                self.aprovar_transacao()

                with patch.object(
                    self.client,
                    "transact_write_items",
                    wraps=self.client.transact_write_items,
                ) as transacao:
                    resultado = self.executar(metodo)

                self.assertEqual(resultado["status"], "aprovado")
                self.assertEqual(resultado["valor"], 120)
                self.assertEqual(resultado["limite_restante"], 380)
                self.assertEqual(
                    resultado["metodo_pagamento"],
                    metodo,
                )

                transacao.assert_called_once()
                operacoes = transacao.call_args.kwargs["TransactItems"]

                self.assertEqual(len(operacoes), 3)
                self.assertEqual(
                    operacoes[0]["Update"]["TableName"],
                    "intencoes-teste",
                )
                self.assertEqual(
                    operacoes[1]["Update"]["TableName"],
                    "usuarios-teste",
                )

                registro = operacoes[2]["Put"]
                self.assertEqual(
                    registro["TableName"],
                    "transacoes-teste",
                )
                self.assertEqual(
                    registro["Item"]["valor_centavos"],
                    {"N": "12000"},
                )
                self.assertEqual(
                    registro["Item"]["transacao_id"],
                    {"S": resultado["transacao_id"]},
                )

                self.stubber.assert_no_pending_responses()

    def test_metodo_invalido_nao_consulta_banco(self):
        for metodo in ("boleto", "", None):
            with self.subTest(metodo=metodo):
                with patch.object(
                    self.client,
                    "get_item",
                ) as consulta:
                    resultado = self.executar(metodo)

                self.assertEqual(
                    resultado["erro"],
                    "METODO_INVALIDO",
                )
                consulta.assert_not_called()

    def test_intencao_inexistente_ou_de_outro_usuario(self):
        for item in (None, intencao(usuario="outro-usuario")):
            with self.subTest(item=item):
                self.consultar_intencao(item)

                resultado = self.executar()

                self.assertEqual(
                    resultado["erro"],
                    "INTENCAO_INVALIDA",
                )
                self.stubber.assert_no_pending_responses()

    def test_intencao_paga_nao_debita_novamente(self):
        self.consultar_intencao(
            intencao(status="paga", expiracao=900)
        )

        resultado = self.executar()

        self.assertEqual(resultado["erro"], "INTENCAO_JA_PAGA")
        self.expirar.assert_not_called()
        self.stubber.assert_no_pending_responses()

    def test_intencao_vencida_libera_reserva_e_recusa(self):
        item = intencao(expiracao=900)
        self.consultar_intencao(item)

        resultado = self.executar()

        self.assertEqual(resultado["erro"], "INTENCAO_EXPIRADA")
        self.expirar.assert_called_once_with(
            client=self.client,
            tabela_intencoes="intencoes-teste",
            tabela_catalogo="catalogo-teste",
            intencao=item,
            agora_epoch=1000,
        )
        self.stubber.assert_no_pending_responses()

    def test_limite_insuficiente_nao_inicia_pagamento(self):
        self.consultar_intencao(intencao())
        self.consultar_usuario(limite=10000)

        with patch.object(
            self.client,
            "transact_write_items",
        ) as transacao:
            resultado = self.executar()

        self.assertEqual(resultado["erro"], "LIMITE_EXCEDIDO")
        transacao.assert_not_called()
        self.stubber.assert_no_pending_responses()

    def test_pagamento_concorrente_e_identificado_na_releitura(self):
        self.consultar_intencao(intencao())
        self.consultar_usuario()
        self.recusar_transacao(
            ["ConditionalCheckFailed", "None", "None"]
        )
        self.consultar_intencao(intencao(status="paga"))

        resultado = self.executar()

        self.assertEqual(resultado["erro"], "INTENCAO_JA_PAGA")
        self.stubber.assert_no_pending_responses()

    def test_limite_consumido_por_outra_compra(self):
        self.consultar_intencao(intencao())
        self.consultar_usuario()
        self.recusar_transacao(
            ["None", "ConditionalCheckFailed", "None"]
        )

        self.consultar_intencao(intencao())
        self.consultar_usuario(limite=10000)

        resultado = self.executar()

        self.assertEqual(resultado["erro"], "LIMITE_EXCEDIDO")
        self.stubber.assert_no_pending_responses()

    def test_recalcula_saldo_apos_disputa_e_aprova(self):
        self.consultar_intencao(intencao())
        self.consultar_usuario(limite=50000)
        self.recusar_transacao(
            ["None", "ConditionalCheckFailed", "None"]
        )

        self.consultar_intencao(intencao())
        self.consultar_usuario(limite=40000)
        self.aprovar_transacao()

        resultado = self.executar()

        self.assertEqual(resultado["status"], "aprovado")
        self.assertEqual(resultado["limite_restante"], 280)
        self.stubber.assert_no_pending_responses()

    def test_conflitos_persistentes_tem_limite_de_tentativas(self):
        for _ in range(3):
            self.consultar_intencao(intencao())
            self.consultar_usuario()
            self.recusar_transacao(
                ["TransactionConflict", "None", "None"]
            )

        # Última leitura apenas classifica o resultado.
        self.consultar_intencao(intencao())
        self.consultar_usuario()

        with patch.object(
            self.client,
            "transact_write_items",
            wraps=self.client.transact_write_items,
        ) as transacao:
            resultado = self.executar()

        self.assertEqual(resultado["erro"], "ERRO_INTERNO")
        self.assertEqual(transacao.call_count, 3)
        self.stubber.assert_no_pending_responses()

    def test_handler_exige_contexto_separado(self):
        evento_recebido = {
            "argumentos": {
                "usuario_id": "usuario-forjado",
                "intencao_id": "int_001",
                "metodo_pagamento": "pix",
            }
        }

        with (
            patch.object(compra.boto3, "client") as criar_cliente,
            self.assertLogs(compra.logger, level="ERROR"),
        ):
            resultado = compra.handler(evento_recebido, None)

        self.assertEqual(resultado["erro"], "ERRO_INTERNO")
        criar_cliente.assert_not_called()

    def test_handler_ignora_valor_e_identidade_do_modelo(self):
        evento_recebido = {
            "argumentos": {
                "intencao_id": "int_001",
                "metodo_pagamento": "pix",
                "usuario_id": "usuario-forjado",
                "valor": 0.01,
            },
            "contexto": {
                "usuario_id": "usuario-autenticado",
            },
        }

        with (
            patch.dict(
                os.environ,
                {
                    "USUARIOS_TABLE": "usuarios-teste",
                    "INTENCOES_TABLE": "intencoes-teste",
                    "TRANSACOES_TABLE": "transacoes-teste",
                    "CATALOGO_TABLE": "catalogo-teste",
                },
            ),
            patch.object(
                compra.boto3,
                "client",
                return_value=self.client,
            ),
            patch.object(
                compra,
                "realizar_compra",
                return_value={"status": "aprovado"},
            ) as executar,
        ):
            resultado = compra.handler(evento_recebido, None)

        executar.assert_called_once_with(
            client=self.client,
            tabela_usuarios="usuarios-teste",
            tabela_intencoes="intencoes-teste",
            tabela_transacoes="transacoes-teste",
            tabela_catalogo="catalogo-teste",
            usuario_id="usuario-autenticado",
            intencao_id="int_001",
            metodo_pagamento="pix",
        )
        self.assertEqual(resultado["status"], "aprovado")


if __name__ == "__main__":
    unittest.main()