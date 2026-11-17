import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handler } from "../src/registrar-intencao"
import { ddbMock, FONE, OUTRO_USUARIO, USUARIO } from "./setup"

const AGORA = new Date("2026-11-15T12:00:00.000Z")

describe("registrar_intencao", () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(AGORA)
    })
    afterEach(() => vi.useRealTimers())

    it("sem usuario_id recusa com INTENCAO_INVALIDA", async () => {
        const r = await handler({ argumentos: { produto_id: FONE.produto_id, quantidade: 1 } })
        expect(r).toMatchObject({ status: "recusado", erro: "INTENCAO_INVALIDA" })
        expect(ddbMock.calls()).toHaveLength(0)
    })

    it.each([0, -1, 1.5, "2", undefined])("quantidade %s é recusada", async (quantidade) => {
        const r = await handler({ usuario_id: USUARIO, argumentos: { produto_id: FONE.produto_id, quantidade } })
        expect(r).toMatchObject({ status: "recusado", erro: "QUANTIDADE_INVALIDA" })
    })

    it("id inventado vira PRODUTO_NAO_ENCONTRADO sem ir ao banco", async () => {
        const r = await handler({ usuario_id: USUARIO, argumentos: { produto_id: "prod_003", quantidade: 1 } })
        expect(r).toMatchObject({ erro: "PRODUTO_NAO_ENCONTRADO" })
        expect(ddbMock.calls()).toHaveLength(0)
    })

    it("produto inexistente vira PRODUTO_NAO_ENCONTRADO", async () => {
        ddbMock.on(GetCommand).resolves({})
        const r = await handler({
            usuario_id: USUARIO,
            argumentos: { produto_id: "10000000-0000-0000-0000-000000000099", quantidade: 1 },
        })
        expect(r).toMatchObject({ erro: "PRODUTO_NAO_ENCONTRADO" })
    })

    it("quantidade acima do estoque vira ESTOQUE_INSUFICIENTE", async () => {
        ddbMock.on(GetCommand).resolves({ Item: FONE })
        const r = await handler({ usuario_id: USUARIO, argumentos: { produto_id: FONE.produto_id, quantidade: 13 } })
        expect(r).toMatchObject({ erro: "ESTOQUE_INSUFICIENTE" })
        expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0)
    })

    it("registra com valor do catálogo e dono vindo do evento, não dos argumentos", async () => {
        ddbMock.on(GetCommand).resolves({ Item: FONE })
        ddbMock.on(PutCommand).resolves({})

        const r = await handler({
            usuario_id: USUARIO,
            // O modelo tenta forjar dono e preço: ambos devem ser ignorados.
            argumentos: { produto_id: FONE.produto_id, quantidade: 2, usuario_id: OUTRO_USUARIO, preco: 1 },
        })

        expect(r).toMatchObject({
            produto_id: FONE.produto_id,
            quantidade: 2,
            valor_total: 499.8,
            moeda: "BRL",
            status: "pendente",
            expira_em: "2026-11-15T12:15:00.000Z",
        })

        const put = ddbMock.commandCalls(PutCommand)[0]!.args[0].input
        expect(put.TableName).toBe("t-intencoes")
        expect(put.ConditionExpression).toBe("attribute_not_exists(intencao_id)")
        expect(put.Item).toMatchObject({
            usuario_id: USUARIO,
            valor_unitario_centavos: 24990,
            valor_total_centavos: 49980,
            status: "pendente",
        })
        expect(put.Item!.intencao_id).toBe((r as { intencao_id: string }).intencao_id)
        // ttl em segundos, bem depois do expira_em (só limpeza)
        expect(put.Item!.ttl).toBeGreaterThan(AGORA.getTime() / 1000 + 15 * 60)
    })
})
