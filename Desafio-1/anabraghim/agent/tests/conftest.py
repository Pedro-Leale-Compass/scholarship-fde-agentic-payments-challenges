"""Fixtures: nada aqui acessa a AWS.

- Credenciais falsas e IMDS desligado, para que nenhum boto3 encontre credencial real.
- Cliente Lambda com botocore Stubber: qualquer chamada não prevista falha o teste.
- Modelo roteirizado no lugar do Bedrock.
"""

from __future__ import annotations

import io
import json
import os
from collections.abc import AsyncIterator
from typing import Any

import boto3
import pytest
from botocore.response import StreamingBody
from botocore.stub import Stubber

os.environ.update(
    {
        "AWS_ACCESS_KEY_ID": "teste",
        "AWS_SECRET_ACCESS_KEY": "teste",
        "AWS_SESSION_TOKEN": "teste",
        "AWS_REGION": "us-east-1",
        "AWS_DEFAULT_REGION": "us-east-1",
        "AWS_EC2_METADATA_DISABLED": "true",
        "TOOL_LISTAR_CATALOGO": "ana-braghim-tool-listar-catalogo",
        "TOOL_REGISTRAR_INTENCAO": "ana-braghim-tool-registrar-intencao",
        "TOOL_REALIZAR_COMPRA": "ana-braghim-tool-realizar-compra",
        "MODELO_ID": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    }
)
os.environ.pop("AWS_PROFILE", None)

from strands.models import Model  # noqa: E402

from agente import lambdas  # noqa: E402

USUARIO = "6f1c2b9e-3d4a-4e5f-8a7b-9c0d1e2f3a4b"
OUTRO_USUARIO = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d"
FONE = "10000000-0000-0000-0000-000000000001"


def corpo(valor: Any) -> StreamingBody:
    dados = json.dumps(valor).encode("utf-8") if not isinstance(valor, bytes) else valor
    return StreamingBody(io.BytesIO(dados), len(dados))


class LambdaFalsa:
    """Envolve o Stubber com helpers que conferem o evento enviado à tool."""

    def __init__(self) -> None:
        self.cliente = boto3.client("lambda", region_name="us-east-1")
        self.stubber = Stubber(self.cliente)

    def responder(self, funcao: str, evento: dict[str, Any], resposta: Any, erro_funcao: str | None = None) -> None:
        servico: dict[str, Any] = {"StatusCode": 200, "Payload": corpo(resposta)}
        if erro_funcao:
            servico["FunctionError"] = erro_funcao
        self.stubber.add_response(
            "invoke",
            servico,
            {
                "FunctionName": funcao,
                "InvocationType": "RequestResponse",
                "Payload": json.dumps(evento, ensure_ascii=False).encode("utf-8"),
            },
        )

    def falhar(self, codigo: str = "ServiceException") -> None:
        self.stubber.add_client_error("invoke", service_error_code=codigo, http_status_code=500)


@pytest.fixture
def lambda_falsa(monkeypatch: pytest.MonkeyPatch):
    falsa = LambdaFalsa()
    monkeypatch.setattr(lambdas, "_cliente", falsa.cliente)
    with falsa.stubber:
        yield falsa
        falsa.stubber.assert_no_pending_responses()


class ModeloRoteirizado(Model):
    """Modelo falso: cada chamada devolve o próximo passo do roteiro.

    Passos: ("texto", "...") ou ("tool", nome, {argumentos}).
    Guarda as mensagens recebidas em cada chamada para os testes inspecionarem.
    """

    def __init__(self, roteiro: list[tuple[Any, ...]]) -> None:
        self.roteiro = list(roteiro)
        self.chamadas: list[list[dict[str, Any]]] = []
        self.system_prompts: list[str | None] = []

    def update_config(self, **model_config: Any) -> None:
        pass

    def get_config(self) -> Any:
        return {}

    def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):  # pragma: no cover
        raise NotImplementedError

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs) -> AsyncIterator[dict[str, Any]]:
        self.chamadas.append(json.loads(json.dumps(messages, default=str)))
        self.system_prompts.append(system_prompt)
        passo = self.roteiro.pop(0)
        yield {"messageStart": {"role": "assistant"}}
        if passo[0] == "erro":
            raise RuntimeError("Bedrock indisponível")
        if passo[0] == "texto":
            for pedaco in (passo[1][: len(passo[1]) // 2], passo[1][len(passo[1]) // 2 :]):
                yield {"contentBlockDelta": {"delta": {"text": pedaco}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}
            return
        _, nome, argumentos = passo
        identificador = f"tool-{len(self.chamadas)}"
        yield {"contentBlockStart": {"start": {"toolUse": {"toolUseId": identificador, "name": nome}}}}
        yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(argumentos)}}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "tool_use"}}


def mensagem_usuario(texto: str) -> dict[str, Any]:
    return {"role": "user", "content": [{"text": texto}]}


def payload(texto: str = "oi", historico: list[dict[str, Any]] | None = None, usuario: str = USUARIO):
    return {"usuario_id": usuario, "mensagens": [*(historico or []), mensagem_usuario(texto)]}


async def coletar(gerador) -> list[dict[str, Any]]:
    return [evento async for evento in gerador]
