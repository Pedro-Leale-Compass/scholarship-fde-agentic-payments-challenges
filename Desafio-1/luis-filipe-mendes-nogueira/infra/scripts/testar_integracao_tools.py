import argparse
import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

import boto3


def exigir(condicao, mensagem):
    if not condicao:
        raise RuntimeError(mensagem)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="luisfilipe")
    parser.add_argument("--usuario-id", required=True)
    parser.add_argument(
        "--saldo-inicial-centavos",
        type=int,
        default=43000,
    )
    args = parser.parse_args()

    pasta_infra = Path(__file__).resolve().parents[1]
    caminho_relatorio = Path("/tmp/luisfilipe-integracao-tools.json")

    sessao = boto3.Session(
        profile_name=args.profile,
        region_name="us-east-1",
    )
    lambdas = sessao.client("lambda")
    dynamo = sessao.client("dynamodb")
    prefixo = "luis-filipe-mendes-nogueira"

    relatorio = {"usuario_id": args.usuario_id}

    def salvar():
        caminho_relatorio.write_text(
            json.dumps(relatorio, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def chamar(nome, argumentos):
        resposta = lambdas.invoke(
            FunctionName=f"{prefixo}-{nome}",
            InvocationType="RequestResponse",
            Payload=json.dumps({
                "argumentos": argumentos,
                "contexto": {"usuario_id": args.usuario_id},
            }).encode("utf-8"),
        )
        dados = json.loads(resposta["Payload"].read())

        exigir(
            not resposta.get("FunctionError"),
            f"Falha na Lambda: {dados}",
        )
        return dados

    def buscar(tabela, campo, valor):
        resposta = dynamo.get_item(
            TableName=f"{prefixo}-{tabela}",
            Key={campo: {"S": valor}},
            ConsistentRead=True,
        )
        return resposta.get("Item")

    def saldo():
        item = buscar("usuarios", "usuario_id", args.usuario_id)
        exigir(item is not None, "Perfil não encontrado.")
        return int(item["limite_centavos"]["N"])

    def estoque(evento_id):
        item = buscar("catalogo", "evento_id", evento_id)
        exigir(item is not None, f"Evento ausente: {evento_id}")
        return int(item["vagas_restantes"]["N"])

    def reservar(evento_id, valor_esperado):
        resultado = chamar(
            "registrar-intencao",
            {"evento_id": evento_id, "quantidade": 1},
        )
        print("RESERVA:", json.dumps(resultado, ensure_ascii=False))
        exigir(
            isinstance(resultado.get("intencaoId"), str)
            and resultado.get("valorTotal") == valor_esperado,
            f"Reserva inesperada: {resultado}",
        )
        return resultado

    def pagar(intencao_id):
        return chamar(
            "realizar-compra",
            {
                "intencao_id": intencao_id,
                "metodo_pagamento": "cartao",
            },
        )

    def pagar_juntos(ids):
        barreira = Barrier(2)

        def executar(intencao_id):
            barreira.wait(timeout=30)
            return pagar(intencao_id)

        with ThreadPoolExecutor(max_workers=2) as executor:
            return list(executor.map(executar, ids))

    def conferir_resultados(resultados, codigo_recusa):
        print(json.dumps(resultados, ensure_ascii=False, indent=2))

        aprovados = [
            r for r in resultados
            if r.get("status") == "aprovado"
        ]
        recusados = [
            r for r in resultados
            if r.get("status") == "recusado"
            and r.get("erro") == codigo_recusa
        ]

        exigir(len(aprovados) == 1, "Esperávamos uma aprovação.")
        exigir(
            len(recusados) == 1,
            f"Esperávamos uma recusa {codigo_recusa}.",
        )
        return aprovados[0]

    # Proteções antes de fazer qualquer reserva ou compra.
    saldo_inicial = saldo()
    exigir(
        saldo_inicial == args.saldo_inicial_centavos,
        (
            f"Saldo esperado: {args.saldo_inicial_centavos}; "
            f"encontrado: {saldo_inicial}. "
            "Pare e envie o resultado antes de repetir."
        ),
    )
    exigir(
        31500 <= saldo_inicial < 60500,
        "Saldo incompatível com os cenários deste teste.",
    )
    exigir(estoque("evt_004") >= 1, "Sem vagas para o teste de R$ 25.")
    exigir(
        estoque("evt_005") == 2,
        "Esperávamos duas vagas no evt_005. Envie o estoque atual.",
    )

    # 1. Mesma intenção paga simultaneamente.
    print("\nTESTE 1 — PAGAMENTO DUPLICADO CONCORRENTE")
    estoque_004_antes = estoque("evt_004")
    primeira = reservar("evt_004", 25)
    primeira_id = primeira["intencaoId"]

    relatorio["mesma_intencao"] = {"intencao": primeira}
    salvar()

    resultados = pagar_juntos([primeira_id, primeira_id])
    relatorio["mesma_intencao"]["respostas"] = resultados
    salvar()

    aprovado = conferir_resultados(resultados, "INTENCAO_JA_PAGA")

    exigir(saldo() == saldo_inicial - 2500, "Débito duplicado ou incorreto.")
    exigir(
        estoque("evt_004") == estoque_004_antes - 1,
        "Estoque incorreto na compra de R$ 25.",
    )

    transacao = buscar("transacoes", "intencao_id", primeira_id)
    exigir(transacao is not None, "Transação não encontrada.")
    exigir(
        transacao["transacao_id"]["S"] == aprovado["transacao_id"],
        "A transação salva difere da resposta aprovada.",
    )
    print("OK — uma aprovação e um único débito.")

    # 2. Duas reservas de R$ 290, com limite para apenas uma.
    print("\nTESTE 2 — DISPUTA DE LIMITE ENTRE COMPRAS DIFERENTES")
    saldo_antes_disputa = saldo()

    reserva_a = reservar("evt_005", 290)
    relatorio["disputa_limite"] = {"reserva_a": reserva_a}
    salvar()

    reserva_b = reservar("evt_005", 290)
    relatorio["disputa_limite"]["reserva_b"] = reserva_b
    salvar()

    exigir(estoque("evt_005") == 0, "As duas vagas deveriam estar reservadas.")

    # 3. As duas vagas estão reservadas: uma terceira reserva deve falhar.
    print("\nTESTE 3 — VAGAS INSUFICIENTES")
    sem_vagas = chamar(
        "registrar-intencao",
        {"evento_id": "evt_005", "quantidade": 1},
    )
    print(json.dumps(sem_vagas, ensure_ascii=False, indent=2))
    exigir(
        sem_vagas.get("erro") == "VAGAS_INSUFICIENTES",
        "Esperávamos VAGAS_INSUFICIENTES.",
    )
    exigir(estoque("evt_005") == 0, "A recusa alterou o estoque.")

    ids = [reserva_a["intencaoId"], reserva_b["intencaoId"]]
    resultados = pagar_juntos(ids)
    relatorio["disputa_limite"]["respostas"] = resultados
    salvar()

    aprovado = conferir_resultados(resultados, "LIMITE_EXCEDIDO")

    saldo_final_esperado = saldo_antes_disputa - 29000
    exigir(
        saldo() == saldo_final_esperado,
        "A disputa debitou um valor incorreto.",
    )

    paga_id = aprovado["intencao_id"]
    pendente_id = next(i for i in ids if i != paga_id)

    exigir(
        buscar("intencoes", "intencao_id", paga_id)["status"]["S"] == "paga",
        "A intenção aprovada não está paga.",
    )
    exigir(
        buscar("transacoes", "intencao_id", paga_id) is not None,
        "Falta a transação aprovada.",
    )
    exigir(
        buscar("transacoes", "intencao_id", pendente_id) is None,
        "A compra recusada gerou transação.",
    )
    print("OK — apenas uma compra consumiu o limite.")

    # 4. Reexecuta somente a carga, sem novo deploy de infraestrutura.
    print("\nTESTE 4 — CARGA NÃO SOBRESCREVE O CATÁLOGO")
    ids_eventos = [f"evt_{numero:03d}" for numero in range(1, 7)]
    antes = {
        evento_id: buscar("catalogo", "evento_id", evento_id)
        for evento_id in ids_eventos
    }

    carga = subprocess.run(
        [
            sys.executable,
            str(pasta_infra / "scripts" / "seed_catalogo.py"),
            "--profile",
            args.profile,
            "--outputs-file",
            str(pasta_infra / "cdk.out" / "outputs.json"),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    resumo = json.loads(carga.stdout)
    print(resumo)

    exigir(
        resumo == {"criados": 0, "existentes": 6},
        "A carga teve resultado inesperado.",
    )

    depois = {
        evento_id: buscar("catalogo", "evento_id", evento_id)
        for evento_id in ids_eventos
    }
    exigir(antes == depois, "A carga modificou eventos existentes.")
    print("OK — inclusive estoques reduzidos foram preservados.")

    # 5. Aguarda a reserva recusada por limite expirar naturalmente.
    print("\nTESTE 5 — EXPIRAÇÃO REAL E DEVOLUÇÃO DA RESERVA")
    pendente = buscar("intencoes", "intencao_id", pendente_id)
    exigir(
        pendente["status"]["S"] == "pendente",
        "A reserva já mudou de estado. Envie o resultado.",
    )

    prazo = int(pendente["expira_em_epoch"]["N"]) + 3
    relatorio["expiracao"] = {
        "intencao_id": pendente_id,
        "prazo_epoch": prazo,
    }
    salvar()

    while time.time() < prazo:
        restante = prazo - time.time()
        print(f"Aguardando expiração: aproximadamente {int(restante) + 1}s.")
        time.sleep(min(30, restante))

    estoque_antes_expirar = estoque("evt_005")
    expirado = pagar(pendente_id)
    print(json.dumps(expirado, ensure_ascii=False, indent=2))

    exigir(
        expirado.get("erro") == "INTENCAO_EXPIRADA",
        "Esperávamos INTENCAO_EXPIRADA.",
    )
    exigir(
        estoque("evt_005") == estoque_antes_expirar + 1,
        "A reserva não foi devolvida corretamente.",
    )
    exigir(
        buscar("intencoes", "intencao_id", pendente_id)["status"]["S"]
        == "expirada",
        "O estado da intenção não foi atualizado.",
    )
    exigir(
        buscar("transacoes", "intencao_id", pendente_id) is None,
        "A intenção expirada gerou transação.",
    )

    # 6. Uma nova chamada não pode devolver a mesma vaga novamente.
    print("\nTESTE 6 — EXPIRAÇÃO NÃO DEVOLVE VAGAS DUAS VEZES")
    estoque_apos_expirar = estoque("evt_005")
    repeticao = pagar(pendente_id)

    exigir(
        repeticao.get("erro") == "INTENCAO_EXPIRADA",
        "A intenção deixou de ser recusada como expirada.",
    )
    exigir(
        estoque("evt_005") == estoque_apos_expirar,
        "A reserva foi devolvida mais de uma vez.",
    )
    exigir(saldo() == saldo_final_esperado, "A expiração alterou o limite.")
    print("OK — devolução única e saldo preservado.")

    # 7. A limpeza do catálogo não deve devolver vagas já vendidas.
    print("\nTESTE 7 — CATÁLOGO APÓS AS EXPIRAÇÕES")
    catalogo = chamar("listar-catalogo", {})
    exigir(
        isinstance(catalogo.get("produtos"), list),
        f"Falha na listagem: {catalogo}",
    )
    exigir(
        estoque("evt_004") == estoque_004_antes - 1,
        "A listagem devolveu uma vaga já vendida.",
    )
    exigir(estoque("evt_005") == 1, "Estoque final inesperado no evt_005.")
    exigir(
        pagar(primeira_id).get("erro") == "INTENCAO_JA_PAGA",
        "Uma intenção paga mudou indevidamente de estado.",
    )
    exigir(saldo() == saldo_final_esperado, "O saldo final mudou.")

    relatorio["concluido"] = True
    relatorio["saldo_final_centavos"] = saldo()
    relatorio["estoque_final_evt_005"] = estoque("evt_005")
    salvar()

    print("\nTODOS OS TESTES CONCLUÍDOS.")
    print(f"Saldo final: {saldo_final_esperado} centavos.")
    print(f"Relatório: {caminho_relatorio}")


if __name__ == "__main__":
    main()