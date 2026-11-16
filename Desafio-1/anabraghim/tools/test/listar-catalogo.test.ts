import { ScanCommand } from "@aws-sdk/lib-dynamodb"
import { describe, expect, it } from "vitest"
import { handler } from "../src/listar-catalogo"
import { ddbMock, FONE, TECLADO } from "./setup"

describe("listar_catalogo", () => {
    it("devolve o contrato da Fase 1 com preço em reais", async () => {
        ddbMock.on(ScanCommand).resolves({ Items: [TECLADO, FONE] })

        const r = await handler({ usuario_id: "u", argumentos: {} })

        expect(r).toEqual({
            produtos: [
                { id: FONE.produto_id, nome: "Fone Bluetooth", preco: 249.9, moeda: "BRL", estoque: 12 },
                { id: TECLADO.produto_id, nome: "Teclado Mecânico", preco: 459, moeda: "BRL", estoque: 5 },
            ],
        })
        expect(ddbMock.commandCalls(ScanCommand)[0]!.args[0].input.FilterExpression).toBeUndefined()
    })

    it("filtra por categoria", async () => {
        ddbMock.on(ScanCommand).resolves({ Items: [TECLADO] })

        await handler({ argumentos: { categoria: " perifericos " } })

        const input = ddbMock.commandCalls(ScanCommand)[0]!.args[0].input
        expect(input.FilterExpression).toBe("categoria = :categoria")
        expect(input.ExpressionAttributeValues).toEqual({ ":categoria": "perifericos" })
    })

    it("segue a paginação do Scan", async () => {
        ddbMock
            .on(ScanCommand)
            .resolvesOnce({ Items: [FONE], LastEvaluatedKey: { produto_id: FONE.produto_id } })
            .resolvesOnce({ Items: [TECLADO] })

        const r = (await handler({ argumentos: {} })) as { produtos: unknown[] }

        expect(r.produtos).toHaveLength(2)
        expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2)
    })

    it("falha do DynamoDB vira FALHA_NA_FERRAMENTA, sem stack trace", async () => {
        ddbMock.on(ScanCommand).rejects(new Error("connection reset"))

        const r = await handler({ argumentos: {} })

        expect(r).toMatchObject({ status: "recusado", erro: "FALHA_NA_FERRAMENTA" })
        expect(JSON.stringify(r)).not.toContain("connection reset")
    })
})
