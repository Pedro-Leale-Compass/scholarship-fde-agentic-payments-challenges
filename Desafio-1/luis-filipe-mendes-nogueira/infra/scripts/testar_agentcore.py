import json
from copy import deepcopy
from pathlib import Path
from uuid import uuid4

import boto3
from botocore import UNSIGNED
from botocore.config import Config
from botocore.exceptions import ClientError


PERFIL = "luisfilipe"
REGIAO = "us-east-1"
USUARIO = "1488e458-90a1-702e-1cdf-270c08704e31"

ARN_RUNTIME = (
    "arn:aws:bedrock-agentcore:us-east-1:631570928305:"
    "runtime/luis_filipe_mendes_nogueira_agent-Guuy8W6O51"
)

RELATORIO = Path("/tmp/luisfilipe-agentcore-validacao.json")


def parametros(payload, sessao_id):
    return {
        "agentRuntimeArn": ARN_RUNTIME,
        "qualifier": "DEFAULT",
        "runtimeSessionId": sessao_id,
        "contentType": "application/json",
        "accept": "application/json",
        "payload": json.dumps(
            payload, ensure_ascii=False
        ).encode("utf-8"),
    }


def entrada(mensagem, historico=None):
    return {
        "mensagem": mensagem,
        "contexto": {"usuario_id": USUARIO},
        "historico": historico if historico is not None else [],
    }


def verificar(condicao, mensagem):
    if not condicao:
        raise AssertionError(mensagem)


def main():
    sessao = boto3.Session(
        profile_name=PERFIL,
        region_name=REGIAO,
    )

    cliente = sessao.client(
        "bedrock-agentcore",
        config=Config(
            connect_timeout=5,
            read_timeout=120,
            retries={"total_max_attempts": 1},
        ),
    )

    anonimo = sessao.client(
        "bedrock-agentcore",
        config=Config(
            signature_version=UNSIGNED,
            connect_timeout=5,
            read_timeout=30,
            retries={"total_max_attempts": 1},
        ),
    )

    relatorio = {"testes": [], "respostas": {}}
    falhas_encerramento = []
    teste_atual = "Inicialização"

    def concluir(nome):
        relatorio["testes"].append({
            "teste": nome,
            "ok": True,
        })
        print(f"OK — {nome}", flush=True)

    def encerrar(sessao_id):
        try:
            cliente.stop_runtime_session(
                agentRuntimeArn=ARN_RUNTIME,
                runtimeSessionId=sessao_id,
                qualifier="DEFAULT",
            )
        except ClientError as erro:
            codigo = erro.response["Error"]["Code"]
            if codigo != "ResourceNotFoundException":
                falhas_encerramento.append({
                    "sessao": sessao_id,
                    "erro": codigo,
                })

    def invocar(payload):
        sessao_id = str(uuid4())
        try:
            resposta = cliente.invoke_agent_runtime(
                **parametros(payload, sessao_id)
            )
            corpo = resposta["response"]
            try:
                dados = json.loads(corpo.read())
            finally:
                corpo.close()

            verificar(
                resposta.get("statusCode") == 200,
                f"HTTP inesperado: {resposta.get('statusCode')}",
            )
            verificar(
                isinstance(dados, dict),
                "O runtime não retornou um objeto JSON.",
            )
            return dados
        finally:
            encerrar(sessao_id)

    try:
        teste_atual = "Chamada sem assinatura IAM é bloqueada"
        sessao_anonima = str(uuid4())

        try:
            resposta = anonimo.invoke_agent_runtime(
                **parametros({}, sessao_anonima)
            )
        except ClientError as erro:
            status = erro.response["ResponseMetadata"]["HTTPStatusCode"]
            verificar(
                status in (401, 403),
                f"Falha inesperada na chamada anônima: {erro}",
            )
        else:
            resposta["response"].close()
            encerrar(sessao_anonima)
            raise AssertionError(
                "O endpoint aceitou uma chamada sem assinatura IAM."
            )

        concluir(teste_atual)

        invalidos = [
            (
                "Contexto de identidade ausente",
                {"mensagem": "Olá."},
            ),
            (
                "Identidade externa não substitui contexto",
                {
                    "mensagem": "Olá.",
                    "usuario_id": USUARIO,
                    "historico": [],
                },
            ),
            (
                "Mensagem deve ser texto",
                entrada({"text": "Olá."}),
            ),
            (
                "Histórico deve ser uma lista",
                {
                    **entrada("Olá."),
                    "historico": {"messages": []},
                },
            ),
        ]

        for nome, payload in invalidos:
            teste_atual = nome
            resultado = invocar(payload)

            verificar(
                resultado.get("erro") == "PAYLOAD_INVALIDO",
                f"Entrada inválida foi aceita: {resultado}",
            )
            concluir(nome)

        teste_atual = "Catálogo filtrado por Workshop"
        codigo = f"REF-{uuid4().hex[:12]}"

        resultado = invocar(entrada(
            f"Código de referência desta conversa: {codigo}. "
            "Use listar_catalogo com categoria Workshop e mostre "
            "os eventos encontrados. Não registre intenções "
            "nem realize compras."
        ))

        verificar(
            "erro" not in resultado,
            f"Falha do agente: {resultado}",
        )
        relatorio["respostas"]["catalogo"] = resultado

        historico = resultado.get("historico", [])
        chamadas = [
            bloco["toolUse"]
            for mensagem in historico
            for bloco in mensagem.get("content", [])
            if "toolUse" in bloco
        ]

        verificar(
            chamadas,
            "O agente não chamou ferramentas.",
        )
        verificar(
            all(c["name"] == "listar_catalogo" for c in chamadas),
            f"Ferramenta inesperada: {chamadas}",
        )

        chamadas_filtradas = {
            chamada["toolUseId"]
            for chamada in chamadas
            if chamada.get("input", {}).get(
                "categoria", ""
            ).strip().casefold() == "workshop"
        }

        verificar(
            chamadas_filtradas,
            "O agente não encaminhou o filtro Workshop.",
        )

        catalogos = []
        for mensagem in historico:
            for bloco in mensagem.get("content", []):
                retorno = bloco.get("toolResult", {})
                if retorno.get("toolUseId") not in chamadas_filtradas:
                    continue

                verificar(
                    retorno.get("status") == "success",
                    f"Falha na ferramenta: {retorno}",
                )

                for conteudo in retorno.get("content", []):
                    if "text" in conteudo:
                        dados = json.loads(conteudo["text"])
                        if "produtos" in dados:
                            catalogos.append(dados["produtos"])

        verificar(catalogos, "Resultado do catálogo ausente.")
        verificar(
            {p["id"] for p in catalogos[-1]} == {"evt_001", "evt_006"},
            f"Filtro retornou eventos inesperados: {catalogos[-1]}",
        )
        concluir(teste_atual)

        teste_atual = "Histórico completo funciona em outra sessão"
        historico_original = deepcopy(historico)

        continuacao = invocar(entrada(
            "Qual é o código de referência informado na primeira "
            "mensagem? Responda apenas com o código, sem ferramentas.",
            historico=historico,
        ))

        relatorio["respostas"]["continuacao"] = continuacao

        verificar(
            continuacao.get("resposta", "").strip() == codigo,
            f"O agente não recuperou o código: {continuacao}",
        )
        verificar(
            continuacao.get("historico", [])[
                :len(historico_original)
            ] == historico_original,
            "O histórico anterior foi alterado ou truncado.",
        )
        concluir(teste_atual)

        teste_atual = "Requisição sem histórico não herda outra conversa"

        isolado = invocar(entrada(
            "Qual é o código de referência informado anteriormente "
            "nesta conversa? Se não houver código no histórico, "
            "responda apenas SEM_CODIGO. Não use ferramentas."
        ))

        relatorio["respostas"]["isolamento"] = isolado

        verificar(
            isolado.get("resposta", "").strip() == "SEM_CODIGO",
            f"Resposta inesperada sem histórico: {isolado}",
        )
        concluir(teste_atual)

        verificar(
            not falhas_encerramento,
            f"Falhas ao encerrar sessões: {falhas_encerramento}",
        )

        print("\nTODOS OS 8 TESTES PASSARAM.")

    except Exception as erro:
        relatorio["testes"].append({
            "teste": teste_atual,
            "ok": False,
            "erro": str(erro),
        })
        print(f"\nFALHOU — {teste_atual}: {erro}")
        raise SystemExit(1) from None

    finally:
        relatorio["falhas_encerramento"] = falhas_encerramento
        RELATORIO.write_text(
            json.dumps(
                relatorio,
                ensure_ascii=False,
                indent=2,
            ) + "\n",
            encoding="utf-8",
        )
        cliente.close()
        anonimo.close()
        print(f"Relatório: {RELATORIO}")


if __name__ == "__main__":
    main()
