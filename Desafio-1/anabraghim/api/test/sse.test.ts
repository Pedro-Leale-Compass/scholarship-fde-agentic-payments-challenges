import { describe, expect, it } from "vitest"
import { lerEventosSse } from "../src/shared/sse"

async function coletar(chunks: (string | Uint8Array)[]) {
    async function* gerar() {
        yield* chunks
    }
    const eventos: unknown[] = []
    for await (const evento of lerEventosSse(gerar())) eventos.push(evento)
    return eventos
}

describe("lerEventosSse", () => {
    it("lê eventos separados por linha em branco", async () => {
        expect(await coletar(['data: {"tipo":"texto","texto":"Olá"}\n\ndata: {"tipo":"fim"}\n\n'])).toEqual([
            { tipo: "texto", texto: "Olá" },
            { tipo: "fim" },
        ])
    })

    it("junta linhas cortadas entre chunks, inclusive no meio de um caractere UTF-8", async () => {
        const bytes = new TextEncoder().encode('data: {"tipo":"texto","texto":"ação"}\n\n')
        const corte = bytes.indexOf(0xc3) + 1 // corta no meio do "ç"
        expect(await coletar([bytes.slice(0, corte), bytes.slice(corte)])).toEqual([{ tipo: "texto", texto: "ação" }])
    })

    it("aceita CRLF e o último evento sem quebra de linha final", async () => {
        expect(await coletar(['data: {"a":1}\r\n\r\n', 'data: {"b":2}'])).toEqual([{ a: 1 }, { b: 2 }])
    })

    it("ignora comentários e linhas que não são data", async () => {
        expect(await coletar([': ping\n', 'event: x\n', 'data: {"ok":true}\n\n'])).toEqual([{ ok: true }])
    })

    it("marca JSON inválido sem interromper o stream", async () => {
        expect(await coletar(["data: {quebrado\n\n", 'data: {"ok":true}\n\n'])).toEqual([{ tipo: "invalido" }, { ok: true }])
    })
})
