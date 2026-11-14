import json


def responder(status, dados):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
        },
        "body": json.dumps(dados, ensure_ascii=False),
    }


def handler(event, context):
    claims = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
    )

    usuario_id = claims.get("sub")

    if not usuario_id:
        return responder(
            401,
            {"mensagem": "Identidade autenticada não encontrada."},
        )

    return responder(
        200,
        {"usuario_id": usuario_id},
    )