import argparse
import json
from pathlib import Path
import secrets
import string

import boto3
from botocore.exceptions import ClientError


def generate_temp_password():
    alphabet = string.ascii_letters + string.digits
    token = "".join(secrets.choice(alphabet) for _ in range(8))
    return f"Tmp@{token}9a!"


def load_outputs():
    outputs_path = Path(__file__).resolve().parents[1] / "cdk-outputs.json"
    if not outputs_path.is_file():
        raise FileNotFoundError("Execute deploy.ps1 antes de criar usuários.")
    outputs = json.loads(outputs_path.read_text(encoding="utf-8"))
    return outputs["fellows-carlos-eduardo"]


def main():
    parser = argparse.ArgumentParser(
        description="Convida um usuário Cognito e configura seu limite ChatPay."
    )
    parser.add_argument("--username", required=True)
    parser.add_argument("--email", required=True)
    parser.add_argument("--limit-centavos", type=int, required=True)
    args = parser.parse_args()
    if args.limit_centavos <= 0:
        parser.error("--limit-centavos precisa ser maior que zero.")

    outputs = load_outputs()
    region = "us-east-1"
    temp_password = generate_temp_password()
    cognito = boto3.client("cognito-idp", region_name=region)
    user_attrs = [
        {"Name": "email", "Value": args.email},
        {"Name": "email_verified", "Value": "true"},
    ]
    try:
        response = cognito.admin_create_user(
            UserPoolId=outputs["UserPoolId"],
            Username=args.username,
            TemporaryPassword=temp_password,
            UserAttributes=user_attrs,
            DesiredDeliveryMediums=["EMAIL"],
        )
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") != "UsernameExistsException":
            raise
        response = cognito.admin_create_user(
            UserPoolId=outputs["UserPoolId"],
            Username=args.username,
            TemporaryPassword=temp_password,
            UserAttributes=user_attrs,
            DesiredDeliveryMediums=["EMAIL"],
            MessageAction="RESEND",
        )
    attributes = {
        attribute["Name"]: attribute["Value"]
        for attribute in response["User"].get("Attributes", [])
    }
    user_id = attributes.get("sub")
    if not user_id:
        profile = cognito.admin_get_user(
            UserPoolId=outputs["UserPoolId"],
            Username=args.username,
        )
        user_id = next(
            attribute["Value"]
            for attribute in profile["UserAttributes"]
            if attribute["Name"] == "sub"
        )

    table = boto3.resource("dynamodb", region_name=region).Table(outputs["UsersTable"])
    try:
        table.put_item(
            Item={
                "user_id": user_id,
                "username": args.username,
                "spending_limit_cents": args.limit_centavos,
                "spent_cents": 0,
            },
            ConditionExpression="attribute_not_exists(user_id)",
        )
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
    print(
        f"Convite enviado para {args.email} (senha temporária: {temp_password}); "
        "limite configurado em centavos."
    )


if __name__ == "__main__":
    main()
