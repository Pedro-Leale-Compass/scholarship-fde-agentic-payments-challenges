import copy
import io
import json
from collections.abc import AsyncGenerator, AsyncIterator, Callable
from typing import Any

import pytest
from strands.models import Model

import main
import tools


class ModeloRoteiro(Model):
    def __init__(self, respostas: list[dict[str, Any]]):
        self.respostas = list(respostas)
        self.chamadas: list[list[dict[str, Any]]] = []
        self._contador_tool = 0

    def update_config(self, **model_config: Any) -> None:
        return None

    def get_config(self) -> dict[str, Any]:
        return {}

    async def structured_output(self, *args: Any, **kwargs: Any) -> AsyncGenerator[dict[str, Any], None]:
        raise NotImplementedError("structured_output não é usado pelo agente")
        yield {}

    async def stream(self, messages: Any, *args: Any, **kwargs: Any) -> AsyncIterator[dict[str, Any]]:
        self.chamadas.append(copy.deepcopy(messages))
        resposta = self.respostas.pop(0)

        yield {"messageStart": {"role": "assistant"}}

        if "tool" in resposta:
            self._contador_tool += 1
            yield {
                "contentBlockStart": {
                    "start": {"toolUse": {"name": resposta["tool"], "toolUseId": f"tooluse_{self._contador_tool}"}}
                }
            }
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(resposta["argumentos"])}}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
        else:
            yield {"contentBlockStart": {"start": {}}}
            palavras = resposta["texto"].split(" ")
            for indice, palavra in enumerate(palavras):
                pedaco = palavra if indice == len(palavras) - 1 else f"{palavra} "
                yield {"contentBlockDelta": {"delta": {"text": pedaco}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}

        yield {
            "metadata": {
                "usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0},
                "metrics": {"latencyMs": 0},
            }
        }


class LambdaFalsa:
    def __init__(self) -> None:
        self.eventos: list[tuple[str, dict[str, Any]]] = []
        self.respostas: dict[str, Any] = {}
        self.erro: Exception | None = None
        self.function_error: str | None = None

    def invoke(self, FunctionName: str, Payload: bytes) -> dict[str, Any]:
        self.eventos.append((FunctionName, json.loads(Payload)))
        if self.erro is not None:
            raise self.erro
        corpo = self.respostas.get(FunctionName, {})
        resposta: dict[str, Any] = {"StatusCode": 200, "Payload": io.BytesIO(json.dumps(corpo).encode("utf-8"))}
        if self.function_error is not None:
            resposta["FunctionError"] = self.function_error
        return resposta


@pytest.fixture(autouse=True)
def ambiente_seguro(monkeypatch: pytest.MonkeyPatch) -> None:
    for variavel in ("AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_SESSION_TOKEN", "MODEL_ID"):
        monkeypatch.delenv(variavel, raising=False)
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "teste")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "teste")
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")


@pytest.fixture
def lambda_falsa(monkeypatch: pytest.MonkeyPatch) -> LambdaFalsa:
    falsa = LambdaFalsa()
    monkeypatch.setattr(tools, "get_lambda_client", lambda: falsa)
    monkeypatch.setenv("LAMBDA_LISTAR_CATALOGO", "teste-listar-catalogo")
    monkeypatch.setenv("LAMBDA_REGISTRAR_INTENCAO", "teste-registrar-intencao")
    monkeypatch.setenv("LAMBDA_REALIZAR_COMPRA", "teste-realizar-compra")
    return falsa


@pytest.fixture
def create_modelo(monkeypatch: pytest.MonkeyPatch) -> Callable[[list[dict[str, Any]]], ModeloRoteiro]:
    def create(respostas: list[dict[str, Any]]) -> ModeloRoteiro:
        modelo = ModeloRoteiro(respostas)
        monkeypatch.setattr(main, "BedrockModel", lambda **kwargs: modelo)
        return modelo

    return create
