import { describe, expect, it } from "vitest"
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb"
import { handler as conversas } from "../src/conversas"
import { handler as perfil } from "../src/perfil"
import { MAX_HISTORICO } from "../src/shared/conversas"
import { USUARIO, ddbMock, eventoApi } from "./setup"

function item(i: number, role: string, content: unknown[]) {
    return { usuario_id: USUARIO, sk: `msg#2026-11-15T10:00:00.000Z#aaaa#${String(i).padStart(3, "0")}`, role, content, criado_em: `2026-11-15T10:00:0${i}.000Z` }
}

describe("GET /conversas", () => {
    it("sem sub responde 401 sem ler a tabela", async () => {
        const resposta = await conversas(eventoApi({ sub: null }))

        expect(resposta.statusCode).toBe(401)
        expect(ddbMock.calls()).toHaveLength(0)
    })

    it("devolve só o texto, em ordem cronológica, sem tools nem raciocínio", async () => {
        ddbMock.on(QueryCommand).resolves({
            Items: [
                item(0, "user", [{ text: "o que tem?" }]),
                item(1, "assistant", [{ text: "Vou consultar." }, { toolUse: { toolUseId: "t1", name: "listar_catalogo", input: {} } }]),
                item(2, "user", [{ toolResult: { toolUseId: "t1", status: "success", content: [{ text: "{}" }] } }]),
                item(3, "assistant", [{ reasoningContent: { reasoningText: { text: "pensando" } } }, { text: "Temos fones." }]),
            ].reverse(),
        })

        const resposta = await conversas(eventoApi())

        expect(resposta.statusCode).toBe(200)
        expect(resposta.headers).toMatchObject({ "Content-Type": "application/json; charset=utf-8" })
        expect(JSON.parse(resposta.body)).toEqual({
            mensagens: [
                { papel: "usuario", texto: "o que tem?", criado_em: "2026-11-15T10:00:00.000Z" },
                { papel: "assistente", texto: "Vou consultar.", criado_em: "2026-11-15T10:00:01.000Z" },
                { papel: "assistente", texto: "Temos fones.", criado_em: "2026-11-15T10:00:03.000Z" },
            ],
        })
        expect(ddbMock.commandCalls(QueryCommand)[0]!.args[0].input.ExpressionAttributeValues![":usuario"]).toBe(USUARIO)
    })

    it("pagina até o limite de mensagens", async () => {
        ddbMock
            .on(QueryCommand)
            .resolvesOnce({ Items: [item(1, "assistant", [{ text: "b" }])], LastEvaluatedKey: { usuario_id: USUARIO, sk: "x" } })
            .resolvesOnce({ Items: [item(0, "user", [{ text: "a" }])] })

        const resposta = await conversas(eventoApi())

        expect(JSON.parse(resposta.body).mensagens.map((m: { texto: string }) => m.texto)).toEqual(["a", "b"])
        const chamadas = ddbMock.commandCalls(QueryCommand).map((c) => c.args[0].input)
        expect(chamadas[0]!.Limit).toBe(MAX_HISTORICO)
        expect(chamadas[1]!.Limit).toBe(MAX_HISTORICO - 1)
        expect(chamadas[1]!.ExclusiveStartKey).toEqual({ usuario_id: USUARIO, sk: "x" })
    })

    it("histórico vazio devolve lista vazia", async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] })

        expect(JSON.parse((await conversas(eventoApi())).body)).toEqual({ mensagens: [] })
    })

    it("falha no DynamoDB vira 500 sem detalhe técnico", async () => {
        ddbMock.on(QueryCommand).rejects(new Error("AccessDenied: arn interno"))

        const resposta = await conversas(eventoApi())

        expect(resposta.statusCode).toBe(500)
        expect(resposta.body).not.toContain("arn")
    })
})

describe("GET /perfil", () => {
    it("sem sub responde 401", async () => {
        expect((await perfil(eventoApi({ sub: null }))).statusCode).toBe(401)
        expect(ddbMock.calls()).toHaveLength(0)
    })

    it("devolve e-mail e limites em reais", async () => {
        ddbMock.on(GetCommand).resolves({
            Item: { usuario_id: USUARIO, limite_total_centavos: 500_000, limite_disponivel_centavos: 250_010 },
        })

        const resposta = await perfil(eventoApi({ email: "ana@exemplo.com" }))

        expect(resposta.statusCode).toBe(200)
        expect(JSON.parse(resposta.body)).toEqual({
            email: "ana@exemplo.com",
            limite_total: 5000,
            limite_disponivel: 2500.1,
            moeda: "BRL",
        })
        expect(ddbMock.commandCalls(GetCommand)[0]!.args[0].input).toMatchObject({
            TableName: "t-usuarios",
            Key: { usuario_id: USUARIO },
        })
    })

    it("usuário ainda sem registro vê o limite padrão de R$ 500,00", async () => {
        ddbMock.on(GetCommand).resolves({})

        expect(JSON.parse((await perfil(eventoApi())).body)).toMatchObject({ limite_total: 500, limite_disponivel: 500 })
    })

    it("falha no DynamoDB vira 500", async () => {
        ddbMock.on(GetCommand).rejects(new Error("boom"))

        expect((await perfil(eventoApi())).statusCode).toBe(500)
    })
})
