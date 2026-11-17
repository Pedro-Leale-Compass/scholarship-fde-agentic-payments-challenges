import { Readable } from "node:stream"
import { describe, expect, it } from "vitest"
import { InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore"
import { QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb"
import { MAX_CARACTERES_MENSAGEM, MENSAGEM_NAO_SALVA, processarChat } from "../src/chat"
import { MENSAGEM_FALHA } from "../src/shared/http"
import { OUTRO_USUARIO, StreamDeTeste, USUARIO, agentcoreMock, ddbMock, eventoApi } from "./setup"

const PERGUNTA = { role: "user", content: [{ text: "o que tem à venda?" }] }
const TOOL_USE = {
    role: "assistant",
    content: [{ toolUse: { toolUseId: "t1", name: "listar_catalogo", input: {} } }],
}
const TOOL_RESULT = {
    role: "user",
    content: [{ toolResult: { toolUseId: "t1", status: "success", content: [{ text: '{"produtos":[]}' }] } }],
}
const RESPOSTA = { role: "assistant", content: [{ text: "Temos fones." }] }

// O DynamoDB devolve do mais novo para o mais antigo (ScanIndexForward: false).
function historicoNoBanco(mensagens: Record<string, unknown>[]) {
    return mensagens
        .map((m, i) => ({ usuario_id: USUARIO, sk: `msg#2026-11-15T10:00:00.000Z#aaaa#${String(i).padStart(3, "0")}`, ...m }))
        .reverse()
}

function sse(...eventos: unknown[]): string[] {
    return eventos.map((e) => `data: ${JSON.stringify(e)}\n\n`)
}

function agenteResponde(chunks: string[]) {
    agentcoreMock.on(InvokeAgentRuntimeCommand).resolves({
        response: Readable.from(chunks.map((c) => Buffer.from(c))) as never,
        contentType: "text/event-stream",
        statusCode: 200,
    })
}

function corpo(mensagem: unknown, extra: Record<string, unknown> = {}) {
    return JSON.stringify({ mensagem, ...extra })
}

async function chamar(evento = eventoApi({ body: corpo("quero 2 fones") })) {
    const stream = new StreamDeTeste()
    await processarChat(evento, stream)
    return stream
}

function payloadEnviado() {
    const chamada = agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)[0]
    const input = chamada!.args[0].input
    return { input, payload: JSON.parse(new TextDecoder().decode(input.payload as Uint8Array)) }
}

const TURNO = [
    { role: "user", content: [{ text: "quero 2 fones" }] },
    { role: "assistant", content: [{ toolUse: { toolUseId: "t2", name: "registrar_intencao", input: { quantidade: 2 } } }] },
    { role: "user", content: [{ toolResult: { toolUseId: "t2", status: "success", content: [{ text: "{}" }] } }] },
    { role: "assistant", content: [{ text: "Registrei." }] },
]

describe("POST /chat", () => {
    it("sem sub do autorizador responde 401 e não chama nada", async () => {
        const stream = await chamar(eventoApi({ sub: null, body: corpo("oi") }))

        expect(stream.metadata?.statusCode).toBe(401)
        expect(JSON.parse(stream.texto)).toEqual({ erro: "Não autenticado." })
        expect(stream.finalizado).toBe(true)
        expect(agentcoreMock.calls()).toHaveLength(0)
        expect(ddbMock.calls()).toHaveLength(0)
    })

    it.each([
        ["sem corpo", null],
        ["JSON inválido", "{quebrado"],
        ["sem mensagem", JSON.stringify({ texto: "oi" })],
        ["mensagem não texto", corpo(42)],
        ["mensagem vazia", corpo("   ")],
        ["mensagem longa demais", corpo("x".repeat(MAX_CARACTERES_MENSAGEM + 1))],
    ])("corpo inválido (%s) responde 400", async (_caso, body) => {
        const stream = await chamar(eventoApi({ body }))

        expect(stream.metadata?.statusCode).toBe(400)
        expect(agentcoreMock.calls()).toHaveLength(0)
    })

    it("caminho feliz: envia histórico + mensagem, transmite e grava o turno", async () => {
        ddbMock.on(QueryCommand).resolves({ Items: historicoNoBanco([PERGUNTA, TOOL_USE, TOOL_RESULT, RESPOSTA]) })
        agenteResponde([
            ...sse({ tipo: "ferramenta", nome: "registrar_intencao" }, { tipo: "texto", texto: "Regis" }),
            // um evento cortado entre chunks
            'data: {"tipo":"texto","tex',
            'to":"trei."}\n\n',
            ...sse({ tipo: "fim", mensagens_novas: TURNO }),
        ])
        ddbMock.on(TransactWriteCommand).resolves({})

        const stream = await chamar()

        expect(stream.metadata).toMatchObject({
            statusCode: 200,
            headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
        })
        expect(stream.eventos).toEqual([
            { tipo: "ferramenta", nome: "registrar_intencao" },
            { tipo: "texto", texto: "Regis" },
            { tipo: "texto", texto: "trei." },
            { tipo: "fim" },
        ])
        expect(stream.finalizado).toBe(true)

        const { input, payload } = payloadEnviado()
        expect(input).toMatchObject({
            agentRuntimeArn: process.env.AGENTE_RUNTIME_ARN,
            qualifier: "DEFAULT",
            runtimeSessionId: `sessao-${USUARIO}`,
            contentType: "application/json",
        })
        expect(input.runtimeSessionId!.length).toBeGreaterThanOrEqual(33)
        expect(payload).toEqual({
            usuario_id: USUARIO,
            mensagens: [PERGUNTA, TOOL_USE, TOOL_RESULT, RESPOSTA, { role: "user", content: [{ text: "quero 2 fones" }] }],
        })

        const query = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input
        expect(query).toMatchObject({
            TableName: "t-conversas",
            ExpressionAttributeValues: { ":usuario": USUARIO, ":prefixo": "msg#" },
            ConsistentRead: true,
        })

        const itens = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!
        expect(itens).toHaveLength(4)
        const gravados = itens.map((i) => i.Put!)
        expect(gravados.every((p) => p.TableName === "t-conversas" && p.Item!.usuario_id === USUARIO)).toBe(true)
        expect(gravados.every((p) => p.ConditionExpression === "attribute_not_exists(sk)")).toBe(true)
        expect(gravados.map((p) => ({ role: p.Item!.role, content: p.Item!.content }))).toEqual(TURNO)
        const chaves = gravados.map((p) => p.Item!.sk as string)
        expect([...chaves].sort()).toEqual(chaves) // ordem preservada pela SK
        expect(chaves[0]).toMatch(/^msg#\d{4}-\d{2}-\d{2}T[\d:.]+Z#[0-9a-f]{8}#000$/)
    })

    it("usuario_id no corpo é ignorado: vale o sub do autorizador", async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] })
        agenteResponde(sse({ tipo: "fim", mensagens_novas: TURNO }))
        ddbMock.on(TransactWriteCommand).resolves({})

        await chamar(eventoApi({ body: corpo("quero 2 fones", { usuario_id: OUTRO_USUARIO }) }))

        expect(payloadEnviado().payload.usuario_id).toBe(USUARIO)
        expect(ddbMock.commandCalls(QueryCommand)[0]!.args[0].input.ExpressionAttributeValues![":usuario"]).toBe(USUARIO)
        const itens = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!
        expect(itens.every((i) => i.Put!.Item!.usuario_id === USUARIO)).toBe(true)
    })

    it("aceita corpo em base64", async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] })
        agenteResponde(sse({ tipo: "fim", mensagens_novas: TURNO }))
        ddbMock.on(TransactWriteCommand).resolves({})

        await chamar(eventoApi({ body: Buffer.from(corpo("ação")).toString("base64"), base64: true }))

        expect(payloadEnviado().payload.mensagens.at(-1)).toEqual({ role: "user", content: [{ text: "ação" }] })
    })

    it("histórico cortado no meio de um turno começa no próximo texto do usuário", async () => {
        ddbMock.on(QueryCommand).resolves({ Items: historicoNoBanco([TOOL_RESULT, RESPOSTA, PERGUNTA, RESPOSTA]) })
        agenteResponde(sse({ tipo: "fim", mensagens_novas: TURNO }))
        ddbMock.on(TransactWriteCommand).resolves({})

        await chamar()

        expect(payloadEnviado().payload.mensagens).toEqual([
            PERGUNTA,
            RESPOSTA,
            { role: "user", content: [{ text: "quero 2 fones" }] },
        ])
    })

    it("erro do agente é repassado e nada é gravado", async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] })
        agenteResponde(sse({ tipo: "texto", texto: "Vou" }, { tipo: "erro", mensagem: "Tente novamente em instantes." }))

        const stream = await chamar()

        expect(stream.eventos).toEqual([
            { tipo: "texto", texto: "Vou" },
            { tipo: "erro", mensagem: "Tente novamente em instantes." },
        ])
        expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0)
    })

    it("erro interno do runtime vira mensagem genérica, sem detalhe técnico", async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] })
        agenteResponde(sse({ error: "KeyError: segredo", error_type: "KeyError", message: "An error occurred" }))

        const stream = await chamar()

        expect(stream.eventos).toEqual([{ tipo: "erro", mensagem: MENSAGEM_FALHA }])
        expect(stream.texto).not.toContain("segredo")
    })

    it("stream que termina sem fim vira erro e nada é gravado", async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] })
        agenteResponde(sse({ tipo: "texto", texto: "Olá" }))

        const stream = await chamar()

        expect(stream.eventos.at(-1)).toEqual({ tipo: "erro", mensagem: MENSAGEM_FALHA })
        expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0)
    })

    it.each([
        ["vazio", []],
        ["sem resposta do assistente", [TURNO[0]]],
        ["começando num toolResult", [TOOL_RESULT, RESPOSTA]],
        ["terminando no usuário", [TURNO[0], TURNO[1], TURNO[2]]],
        ["com role inválido", [TURNO[0], { role: "system", content: [{ text: "x" }] }]],
        ["que não é lista", "texto"],
    ])("evento fim %s não é gravado", async (_caso, mensagensNovas) => {
        ddbMock.on(QueryCommand).resolves({ Items: [] })
        agenteResponde(sse({ tipo: "fim", mensagens_novas: mensagensNovas }))

        const stream = await chamar()

        expect(stream.eventos).toEqual([{ tipo: "erro", mensagem: MENSAGEM_FALHA }])
        expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0)
    })

    it("falha ao gravar avisa o usuário depois da resposta", async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] })
        agenteResponde(sse({ tipo: "texto", texto: "Registrei." }, { tipo: "fim", mensagens_novas: TURNO }))
        ddbMock.on(TransactWriteCommand).rejects(new Error("TransactionCanceledException"))

        const stream = await chamar()

        expect(stream.eventos).toEqual([
            { tipo: "texto", texto: "Registrei." },
            { tipo: "erro", mensagem: MENSAGEM_NAO_SALVA },
        ])
    })

    it("falha ao invocar o agente responde 502 sem abrir o stream", async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] })
        agentcoreMock.on(InvokeAgentRuntimeCommand).rejects(new Error("ThrottlingException: detalhe interno"))

        const stream = await chamar()

        expect(stream.metadata?.statusCode).toBe(502)
        expect(JSON.parse(stream.texto)).toEqual({ erro: MENSAGEM_FALHA })
    })

    it("falha ao ler o histórico responde 502 e não chama o agente", async () => {
        ddbMock.on(QueryCommand).rejects(new Error("ProvisionedThroughputExceeded"))

        const stream = await chamar()

        expect(stream.metadata?.statusCode).toBe(502)
        expect(agentcoreMock.calls()).toHaveLength(0)
    })

    it("envia pulsos enquanto o agente demora e para ao terminar", async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] })
        ddbMock.on(TransactWriteCommand).resolves({})
        async function* agenteLento() {
            await new Promise((r) => setTimeout(r, 60))
            yield Buffer.from(sse({ tipo: "texto", texto: "Pronto." }, { tipo: "fim", mensagens_novas: TURNO }).join(""))
        }
        agentcoreMock.on(InvokeAgentRuntimeCommand).resolves({ response: Readable.from(agenteLento()) as never, contentType: "text/event-stream" })

        const stream = new StreamDeTeste()
        await processarChat(eventoApi({ body: corpo("oi") }), stream, { intervaloPulsoMs: 10 })
        const quantosAoTerminar = stream.eventos.filter((e) => e.tipo === "pulso").length
        await new Promise((r) => setTimeout(r, 40))

        expect(quantosAoTerminar).toBeGreaterThanOrEqual(2)
        expect(stream.eventos.filter((e) => e.tipo === "pulso")).toHaveLength(quantosAoTerminar) // intervalo encerrado
        expect(stream.eventos.filter((e) => e.tipo !== "pulso")).toEqual([{ tipo: "texto", texto: "Pronto." }, { tipo: "fim" }])
        expect(stream.finalizado).toBe(true)
    })

    it("não envia headers de CORS: frontend e API ficam na mesma origem (CloudFront)", async () => {
        const stream = await chamar(eventoApi({ body: null }))

        expect(Object.keys(stream.metadata?.headers as object).some((h) => h.startsWith("Access-Control"))).toBe(false)
    })
})
