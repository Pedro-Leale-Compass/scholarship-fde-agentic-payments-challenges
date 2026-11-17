import json
import os
import unittest
from decimal import Decimal
from unittest.mock import MagicMock, patch

from handlers import lambda_handler


class PurchaseValidationTests(unittest.TestCase):
    def test_list_catalog_serializes_decimal_prices(self):
        fake_table = MagicMock()
        fake_table.scan.return_value = {
            "Items": [
                {
                    "product_id": "prod_001",
                    "name": "Mouse Gamer",
                    "price_cents": Decimal("12990"),
                    "currency": "BRL",
                    "stock": Decimal("15"),
                }
            ]
        }
        with patch.dict(
            os.environ,
            {"TOOL_NAME": "listar_catalogo", "PRODUCTS_TABLE": "products"},
        ), patch("handlers.dynamodb.Table", return_value=fake_table):
            result = lambda_handler(
                {"user_id": "cognito-user", "chat_id": "main", "arguments": {}},
                None,
            )
        encoded = json.dumps(result)
        self.assertIn("129.9", encoded)
        self.assertEqual(result["produtos"][0]["preco"], 129.9)
        self.assertEqual(result["produtos"][0]["estoque"], 15)

    def test_rejects_unsupported_payment_method(self):
        with patch.dict(os.environ, {"TOOL_NAME": "realizar_compra"}):
            result = lambda_handler(
                {
                    "user_id": "cognito-user",
                    "chat_id": "main",
                    "confirmed_method": "pix",
                    "arguments": {
                        "intencao_id": "intent-1",
                        "metodo_pagamento": "dinheiro",
                    },
                },
                None,
            )
        self.assertEqual(result["erro"], "METODO_INVALIDO")

    def test_rejects_empty_intent_id_with_intencao_invalida(self):
        with patch.dict(os.environ, {"TOOL_NAME": "realizar_compra"}):
            result = lambda_handler(
                {
                    "user_id": "cognito-user",
                    "chat_id": "main",
                    "confirmed_method": None,
                    "arguments": {
                        "intencao_id": "",
                        "metodo_pagamento": "pix",
                    },
                },
                None,
            )
        self.assertEqual(result["erro"], "INTENCAO_INVALIDA")

    def test_rejects_conflicting_payment_method_from_user_message(self):
        with patch.dict(os.environ, {"TOOL_NAME": "realizar_compra"}):
            result = lambda_handler(
                {
                    "user_id": "cognito-user",
                    "chat_id": "main",
                    "confirmed_method": "cartao",
                    "arguments": {
                        "intencao_id": "intent-1",
                        "metodo_pagamento": "pix",
                    },
                },
                None,
            )
        self.assertEqual(result["erro"], "METODO_INVALIDO")


if __name__ == "__main__":
    unittest.main()

