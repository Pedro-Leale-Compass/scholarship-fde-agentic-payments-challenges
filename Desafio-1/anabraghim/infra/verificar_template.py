"""Regras de segurança do template que o cfn-lint não cobre. Não acessa a AWS.

    pip install cfn-lint            # mesmo pré-requisito opcional do cfn-lint
    python infra/verificar_template.py

Falha (exit 1) se:
- algum método do API Gateway não exigir o autorizador Cognito;
- a rota do chat não usar response streaming;
- alguma permissão de invocação de Lambda não tiver SourceArn;
- alguma policy IAM usar "*" em Action ou Resource;
- alguma role ou policy usar política gerenciada (ex.: AdministratorAccess);
- algum bucket não bloquear acesso público, ou a policy do site liberar algo além
  da distribuição CloudFront;
- o CloudFront aceitar HTTP, comprimir /api/* ou ler o S3 sem OAC.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from cfnlint.decode import decode

TEMPLATE = Path(__file__).resolve().parent / "template.yaml"


def _lista(valor: Any) -> list[Any]:
    return valor if isinstance(valor, list) else [valor]


def verificar(recursos: dict[str, Any]) -> list[str]:
    problemas: list[str] = []
    for nome, recurso in recursos.items():
        tipo = recurso.get("Type")
        props = recurso.get("Properties", {}) or {}

        if tipo == "AWS::ApiGateway::Method":
            if props.get("AuthorizationType") != "COGNITO_USER_POOLS" or "AuthorizerId" not in props:
                problemas.append(f"{nome}: método sem autorizador Cognito")
            integracao = props.get("Integration", {})
            if props.get("HttpMethod") == "POST" and integracao.get("ResponseTransferMode") != "STREAM":
                problemas.append(f"{nome}: POST /api/chat precisa de ResponseTransferMode STREAM")

        if tipo == "AWS::S3::Bucket":
            bloqueio = props.get("PublicAccessBlockConfiguration", {})
            campos = ("BlockPublicAcls", "BlockPublicPolicy", "IgnorePublicAcls", "RestrictPublicBuckets")
            if not all(bloqueio.get(c) is True for c in campos):
                problemas.append(f"{nome}: bucket sem bloqueio total de acesso público")

        if tipo == "AWS::S3::BucketPolicy":
            for declaracao in _lista(props.get("PolicyDocument", {}).get("Statement", [])):
                if declaracao.get("Effect") != "Allow":
                    continue
                principal = declaracao.get("Principal")
                condicao = declaracao.get("Condition", {}).get("StringEquals", {})
                if principal != {"Service": "cloudfront.amazonaws.com"} or "AWS:SourceArn" not in condicao:
                    problemas.append(f"{nome}: Allow no bucket que não é só da distribuição CloudFront")

        if tipo == "AWS::CloudFront::Distribution":
            config = props.get("DistributionConfig", {})
            comportamentos = [config.get("DefaultCacheBehavior", {}), *config.get("CacheBehaviors", [])]
            for comp in comportamentos:
                if comp.get("ViewerProtocolPolicy") not in ("redirect-to-https", "https-only"):
                    problemas.append(f"{nome}: comportamento aceita HTTP sem TLS")
            for comp in config.get("CacheBehaviors", []):
                if comp.get("PathPattern") == "/api/*" and comp.get("Compress") is not False:
                    problemas.append(f"{nome}: /api/* com compressão seguraria o streaming do chat")
            for origem in config.get("Origins", []):
                if "S3OriginConfig" in origem and "OriginAccessControlId" not in origem:
                    problemas.append(f"{nome}: origem S3 sem OAC")

        if tipo == "AWS::Lambda::Permission" and "SourceArn" not in props:
            problemas.append(f"{nome}: permissão de Lambda sem SourceArn")

        if tipo == "AWS::IAM::Role":
            if props.get("ManagedPolicyArns"):
                problemas.append(f"{nome}: usa política gerenciada")
            for politica in props.get("Policies", []) or []:
                for declaracao in _lista(politica.get("PolicyDocument", {}).get("Statement", [])):
                    for campo in ("Action", "Resource"):
                        for valor in _lista(declaracao.get(campo, [])):
                            if valor == "*" or (isinstance(valor, str) and valor.endswith(":*") and campo == "Action"):
                                problemas.append(f"{nome}: {campo} com curinga ({valor})")
    return problemas


def main() -> None:
    template, erros = decode(str(TEMPLATE))
    if erros or template is None:
        sys.exit(f"não consegui ler {TEMPLATE}: {erros}")
    recursos = template.get("Resources", {})
    problemas = verificar(recursos)
    metodos = sum(1 for r in recursos.values() if r.get("Type") == "AWS::ApiGateway::Method")
    if problemas:
        print("\n".join(problemas))
        sys.exit(1)
    print(f"ok: {len(recursos)} recursos, {metodos} métodos com Cognito, nenhuma permissão com curinga")


if __name__ == "__main__":
    main()
