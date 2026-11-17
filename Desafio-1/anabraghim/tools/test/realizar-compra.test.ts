import { TransactionCanceledException } from "@aws-sdk/client-dynamodb"
import { GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handler } from "../src/realizar-compra"
import { ddbMock, FONE, OUTRO_USUARIO, TECLADO, USUARIO } from "./setup"

const AGORA = new Date("2026-11-15T12:00:00.000Z")
const INTENCAO_ID = "cccccccc-0000-0000-0000-000000000003"

function intencao(over: Record<string, unknown> = {}) {
    return {
        intencao_id: INTENCAO_ID,
        usuario_id: USUARIO,
        produto_id: TECLADO.produto_id,
        quantidade: 2,
        valor_total_centavos: 91800,
        moeda: "BRL",
        status: "pendente",
        expira_em: "2026-11-15T12:10:00.000Z",
        ...over,
    }
}

function usuario(disponivel: number) {
    return { usuario_id: USUARIO, limite_total_centavos: 500000, limite_disponivel_centavos: disponivel }
}

// Configura o GetCommand por tabela. `usuarios` pode receber uma sequência
// (antes e depois da transação).
function banco(opts: { intencao?: unknown; usuarios?: unknown[]; produto?: unknown }) {
    ddbMock.on(GetCommand, { TableName: "t-intencoes" }).resolves({ Item: opts.intencao as never })
    const u = ddbMock.on(GetCommand, { TableName: "t-usuarios" })
    for (const item of opts.usuarios ?? []) u.resolvesOnce({ Item: item as never })
    ddbMock.on(GetCommand, { TableName: "t-produtos" }).resolves({ Item: opts.produto as never })
    ddbMock.on(PutCommand).resolves({})
}

function cancelada(codigos: (string | undefined)[]) {
    return new TransactionCanceledException({
        message: "Transaction cancelled",
        $metadata: {},
        CancellationReasons: codigos.map((Code) => ({ Code: Code ?? "None" })),
    })
}

const pagar = (args: Record<string, unknown>) => handler({ usuario_id: USUARIO, argumentos: args })

describe("realizar_compra", () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(AGORA)
    })
    afterEach(() => vi.useRealTimers())

    describe("recusas antes de ir ao banco", () => {
        it("sem usuario_id → INTENCAO_INVALIDA", async () => {
            // Chamado direto: passar undefined ao `pagar` ativaria o default (USUARIO).
            const r = await handler({ argumentos: { intencao_id: INTENCAO_ID, metodo_pagamento: "pix" } })
            expect(r).toMatchObject({ erro: "INTENCAO_INVALIDA" })
            expect(ddbMock.calls()).toHaveLength(0)
        })

        it("id inventado → INTENCAO_INVALIDA", async () => {
            const r = await pagar({ intencao_id: "int_a1b2c3", metodo_pagamento: "pix" })
            expect(r).toMatchObject({ erro: "INTENCAO_INVALIDA" })
            expect((r as { mensagem: string }).mensagem).toContain("int_a1b2c3")
            expect(ddbMock.calls()).toHaveLength(0)
        })

        it.each(["boleto", "PIX", "", undefined])("método %s → METODO_INVALIDO", async (metodo) => {
            const r = await pagar({ intencao_id: INTENCAO_ID, metodo_pagamento: metodo })
            expect(r).toMatchObject({ erro: "METODO_INVALIDO" })
            expect(ddbMock.calls()).toHaveLength(0)
        })
    })

    describe("pré-checagens", () => {
        it("intenção inexistente → INTENCAO_INVALIDA", async () => {
            banco({})
            expect(await pagar({ intencao_id: INTENCAO_ID, metodo_pagamento: "pix" })).toMatchObject({
                erro: "INTENCAO_INVALIDA",
            })
        })

        it("intenção de outro usuário é indistinguível de inexistente", async () => {
            banco({ intencao: intencao({ usuario_id: OUTRO_USUARIO }) })
            expect(await pagar({ intencao_id: INTENCAO_ID, metodo_pagamento: "pix" })).toMatchObject({
                erro: "INTENCAO_INVALIDA",
            })
            expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0)
        })

        it("intenção já paga → INTENCAO_JA_PAGA", async () => {
            banco({ intencao: intencao({ status: "paga" }) })
            expect(await pagar({ intencao_id: INTENCAO_ID, metodo_pagamento: "pix" })).toMatchObject({
                erro: "INTENCAO_JA_PAGA",
            })
        })

        it("intenção expirada → INTENCAO_EXPIRADA", async () => {
            banco({ intencao: intencao({ expira_em: "2026-11-15T11:59:59.000Z" }) })
            expect(await pagar({ intencao_id: INTENCAO_ID, metodo_pagamento: "pix" })).toMatchObject({
                erro: "INTENCAO_EXPIRADA",
            })
        })

        it("valor acima do limite → LIMITE_EXCEDIDO com o disponível na mensagem", async () => {
            banco({ intencao: intencao(), usuarios: [usuario(50000)], produto: TECLADO })
            const r = await pagar({ intencao_id: INTENCAO_ID, metodo_pagamento: "cartao" })
            expect(r).toMatchObject({ erro: "LIMITE_EXCEDIDO" })
            expect((r as { mensagem: string }).mensagem).toBe(
                "A compra de BRL 918.00 ultrapassa o limite disponível do usuário, que é de BRL 500.00."
            )
            expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0)
        })

        it("usuário sem registro nasce com limite padrão via put condicional", async () => {
            banco({ intencao: intencao(), usuarios: [usuario(50000)], produto: TECLADO })
            await pagar({ intencao_id: INTENCAO_ID, metodo_pagamento: "pix" })

            const put = ddbMock.commandCalls(PutCommand)[0]!.args[0].input
            expect(put.TableName).toBe("t-usuarios")
            expect(put.ConditionExpression).toBe("attribute_not_exists(usuario_id)")
            expect(put.Item).toMatchObject({ usuario_id: USUARIO, limite_disponivel_centavos: 50000 })
        })

        it("estoque mudou → ESTOQUE_INSUFICIENTE", async () => {
            banco({ intencao: intencao(), usuarios: [usuario(500000)], produto: { ...TECLADO, estoque: 1 } })
            expect(await pagar({ intencao_id: INTENCAO_ID, metodo_pagamento: "pix" })).toMatchObject({
                erro: "ESTOQUE_INSUFICIENTE",
            })
        })
    })

    describe("transação", () => {
        it("compra aprovada: escrita atômica com as quatro condições", async () => {
            banco({ intencao: intencao(), usuarios: [usuario(500000), usuario(408200)], produto: TECLADO })
            ddbMock.on(TransactWriteCommand).resolves({})

            const r = await pagar({ intencao_id: INTENCAO_ID, metodo_pagamento: "pix", valor: 0.01 })

            expect(r).toMatchObject({
                status: "aprovado",
                intencao_id: INTENCAO_ID,
                valor: 918,
                metodo_pagamento: "pix",
                limite_restante: 4082,
                data: AGORA.toISOString(),
            })

            const itens = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!
            expect(itens).toHaveLength(4)

            const [int, usr, prod, tx] = itens
            expect(int!.Update!.ConditionExpression).toBe(
                "usuario_id = :usuario AND #status = :pendente AND expira_em > :agora"
            )
            expect(int!.Update!.ExpressionAttributeValues![":usuario"]).toBe(USUARIO)

            // O valor descontado vem da intenção (91800), não do argumento `valor` enviado.
            expect(usr!.Update!.ConditionExpression).toBe("limite_disponivel_centavos >= :valor")
            expect(usr!.Update!.ExpressionAttributeValues).toEqual({ ":valor": 91800 })

            expect(prod!.Update!.ConditionExpression).toBe("estoque >= :quantidade")
            expect(prod!.Update!.ExpressionAttributeValues).toEqual({ ":quantidade": 2 })

            expect(tx!.Put!.ConditionExpression).toBe("attribute_not_exists(intencao_id)")
            expect(tx!.Put!.Item).toMatchObject({
                intencao_id: INTENCAO_ID,
                usuario_id: USUARIO,
                valor_centavos: 91800,
                metodo_pagamento: "pix",
                transacao_id: (r as { transacao_id: string }).transacao_id,
            })
        })

        it("chamada duplicada (corrida): a segunda é cancelada e vira INTENCAO_JA_PAGA", async () => {
            // Pré-checagem ainda vê "pendente"; quando a transação roda, a outra já pagou.
            ddbMock
                .on(GetCommand, { TableName: "t-intencoes" })
                .resolvesOnce({ Item: intencao() })
                .resolvesOnce({ Item: intencao({ status: "paga" }) })
            ddbMock.on(GetCommand, { TableName: "t-usuarios" }).resolves({ Item: usuario(500000) })
            ddbMock.on(GetCommand, { TableName: "t-produtos" }).resolves({ Item: TECLADO })
            ddbMock.on(PutCommand).resolves({})
            ddbMock
                .on(TransactWriteCommand)
                .rejects(cancelada(["ConditionalCheckFailed", "None", "None", "ConditionalCheckFailed"]))

            expect(await pagar({ intencao_id: INTENCAO_ID, metodo_pagamento: "pix" })).toMatchObject({
                erro: "INTENCAO_JA_PAGA",
            })
        })

        it("limite consumido por compra concorrente → LIMITE_EXCEDIDO", async () => {
            banco({ intencao: intencao(), usuarios: [usuario(500000), usuario(10000)], produto: TECLADO })
            ddbMock.on(TransactWriteCommand).rejects(cancelada(["None", "ConditionalCheckFailed", "None", "None"]))

            const r = await pagar({ intencao_id: INTENCAO_ID, metodo_pagamento: "pix" })
            expect(r).toMatchObject({ erro: "LIMITE_EXCEDIDO" })
            expect((r as { mensagem: string }).mensagem).toContain("BRL 100.00")
        })

        it("estoque consumido por compra concorrente → ESTOQUE_INSUFICIENTE", async () => {
            ddbMock
                .on(GetCommand, { TableName: "t-produtos" })
                .resolvesOnce({ Item: TECLADO })
                .resolvesOnce({ Item: { ...TECLADO, estoque: 0 } })
            ddbMock.on(GetCommand, { TableName: "t-intencoes" }).resolves({ Item: intencao() })
            ddbMock.on(GetCommand, { TableName: "t-usuarios" }).resolves({ Item: usuario(500000) })
            ddbMock.on(PutCommand).resolves({})
            ddbMock.on(TransactWriteCommand).rejects(cancelada(["None", "None", "ConditionalCheckFailed", "None"]))

            const r = await pagar({ intencao_id: INTENCAO_ID, metodo_pagamento: "pix" })
            expect(r).toMatchObject({ erro: "ESTOQUE_INSUFICIENTE" })
            expect((r as { mensagem: string }).mensagem).toContain("restam 0 unidades")
        })

        it("conflito de transação sem falha de condição → mensagem para tentar de novo", async () => {
            banco({ intencao: intencao(), usuarios: [usuario(500000)], produto: TECLADO })
            ddbMock
                .on(TransactWriteCommand)
                .rejects(cancelada(["TransactionConflict", "None", "None", "None"]))

            const r = await pagar({ intencao_id: INTENCAO_ID, metodo_pagamento: "pix" })
            expect(r).toMatchObject({ status: "recusado", erro: "FALHA_NA_FERRAMENTA" })
            expect((r as { mensagem: string }).mensagem).toContain("nada foi cobrado")
        })

        it("erro inesperado vira FALHA_NA_FERRAMENTA sem vazar detalhe", async () => {
            banco({ intencao: intencao(), usuarios: [usuario(500000)], produto: FONE })
            ddbMock.on(TransactWriteCommand).rejects(new Error("ProvisionedThroughputExceeded: detalhe interno"))
            vi.spyOn(console, "error").mockImplementation(() => {})

            const r = await pagar({ intencao_id: INTENCAO_ID, metodo_pagamento: "pix" })
            expect(r).toMatchObject({ status: "recusado", erro: "FALHA_NA_FERRAMENTA" })
            expect(JSON.stringify(r)).not.toContain("detalhe interno")
        })
    })
})
