import os

import boto3
from botocore.exceptions import ClientError


PRODUCTS = (
    ("prod_001", "Mouse Gamer", "perifericos", 12990, 15),
    ("prod_002", "Teclado Mecânico", "perifericos", 34990, 8),
    ("prod_003", "Fone Bluetooth", "audio", 24990, 12),
    ("prod_004", "Notebook", "computadores", 459990, 3),
)


def seed_products(table_name, region="us-east-1"):
    table = boto3.resource("dynamodb", region_name=region).Table(table_name)
    for product_id, name, category, price_cents, stock in PRODUCTS:
        try:
            table.put_item(
                Item={
                    "product_id": product_id,
                    "name": name,
                    "category": category,
                    "price_cents": price_cents,
                    "currency": "BRL",
                    "stock": stock,
                },
                ConditionExpression="attribute_not_exists(product_id)",
            )
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise


if __name__ == "__main__":
    seed_products(os.environ["PRODUCTS_TABLE"])
