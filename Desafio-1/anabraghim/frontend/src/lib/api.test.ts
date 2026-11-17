import { describe, expect, it, vi } from "vitest"
import { NaoAutenticadoError, buscarConversas, buscarPerfil, enviarMensagem } from "./api"
import { carregarConfig } from "./config"
import { lerNdjson } from "./ndjson"

// Corpo de resposta que entrega os pedaços um a um, como a rede.
function corpoEmPedacos(pedacos: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
    const codificador = new TextEncoder()
    return new ReadableStream({
        start(controle) {
            for (const p of pedacos) controle.enqueue(typeof p === "string" ? codificador.encode(p) : p)
            controle.close()
        },
    })
}

function respostaStream(pedacos: string[], status = 200) {
    return new Response(corpoEmPedacos(pedacos), { status, headers: { "Content-Type": "application/x-ndjson" } })
}

function respostaJson(corpo: unknown, status = 200) {
    return new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } })
}

async function coletar<T>(gerador: AsyncGenerator<T>): Promise<T[]> {
    const itens: T[] = []
    for await (const item of gerador) itens.push(item)
    return itens
}

describe("lerNdjson", () => {
    it("junta linhas e caracteres UTF-8 cortados entre pedaços", async () => {
        const bytes = new TextEncoder().encode('{"tipo":"texto","texto":"ação"}\n{"tipo":"fim"}\n')
        const corte = bytes.indexOf(0xc3) + 1
        const eventos = await coletar(lerNdjson(corpoEmPedacos([bytes.slice(0, corte), bytes.slice(corte)])))
        expect(eventos).toEqual([{ tipo: "texto", texto: "ação" }, { tipo: "fim" }])
    })

    it("lê a última linha sem quebra final e ignora linhas vazias", async () => {
        expect(await coletar(lerNdjson(corpoEmPedacos(['{"a":1}\n\n', '{"b":2}'])))).toEqual([{ a: 1 }, { b: 2 }])
    })
})

describe("enviarMensagem", () => {
    it("envia só o texto novo com o ID token e devolve os eventos em ordem", async () => {
        const buscar = vi.fn().mockResolvedValue(
            respostaStream([
                '{"tipo":"ferramenta","nome":"listar_catalogo"}\n{"tipo":"tex',
                'to","texto":"Temos "}\n{"tipo":"texto","texto":"fones."}\n',
                '{"tipo":"fim"}\n',
            ])
        )

        const eventos = await coletar(enviarMensagem("o que tem?", "id-token", { buscar }))

        expect(eventos).toEqual([
            { tipo: "ferramenta", nome: "listar_catalogo" },
            { tipo: "texto", texto: "Temos " },
            { tipo: "texto", texto: "fones." },
            { tipo: "fim" },
        ])
        const [rota, init] = buscar.mock.calls[0]!
        expect(rota).toBe("/api/chat")
        expect(init.method).toBe("POST")
        expect(init.headers).toMatchObject({ Authorization: "id-token", "Content-Type": "application/json" })
        expect(JSON.parse(init.body)).toEqual({ mensagem: "o que tem?" })
    })

    it("ignora pulsos e eventos desconhecidos ou malformados", async () => {
        const buscar = vi.fn().mockResolvedValue(
            respostaStream(['{"tipo":"pulso"}\n{"tipo":"novo"}\n{"tipo":"texto"}\n{"tipo":"texto","texto":"ok"}\n{"tipo":"fim"}\n'])
        )
        expect(await coletar(enviarMensagem("oi", "t", { buscar }))).toEqual([
            { tipo: "texto", texto: "ok" },
            { tipo: "fim" },
        ])
    })

    it("stream que termina sem fim vira evento de erro", async () => {
        const buscar = vi.fn().mockResolvedValue(respostaStream(['{"tipo":"texto","texto":"Olá"}\n']))
        const eventos = await coletar(enviarMensagem("oi", "t", { buscar }))
        expect(eventos.at(-1)).toMatchObject({ tipo: "erro" })
    })

    it("linha corrompida no meio do stream vira evento de erro", async () => {
        const buscar = vi.fn().mockResolvedValue(respostaStream(['{"tipo":"texto","texto":"a"}\n{quebrado\n']))
        const eventos = await coletar(enviarMensagem("oi", "t", { buscar }))
        expect(eventos).toEqual([{ tipo: "texto", texto: "a" }, expect.objectContaining({ tipo: "erro" })])
    })

    it("401 lança NaoAutenticadoError", async () => {
        const buscar = vi.fn().mockResolvedValue(respostaJson({ erro: "Sessão expirada" }, 401))
        await expect(coletar(enviarMensagem("oi", "t", { buscar }))).rejects.toBeInstanceOf(NaoAutenticadoError)
    })

    it("outros erros HTTP usam a mensagem do servidor", async () => {
        const buscar = vi.fn().mockResolvedValue(respostaJson({ erro: "Muitas requisições." }, 429))
        await expect(coletar(enviarMensagem("oi", "t", { buscar }))).rejects.toThrow("Muitas requisições.")
    })
})

describe("buscarConversas e buscarPerfil", () => {
    it("lê o histórico com o token", async () => {
        const mensagens = [{ papel: "usuario", texto: "oi" }]
        const buscar = vi.fn().mockResolvedValue(respostaJson({ mensagens }))

        expect(await buscarConversas("tok", buscar)).toEqual(mensagens)
        expect(buscar.mock.calls[0]![0]).toBe("/api/conversas")
        expect(buscar.mock.calls[0]![1].headers).toEqual({ Authorization: "tok" })
    })

    it("histórico em formato inesperado vira lista vazia", async () => {
        expect(await buscarConversas("tok", vi.fn().mockResolvedValue(respostaJson({})))).toEqual([])
    })

    it("perfil com 401 lança NaoAutenticadoError", async () => {
        await expect(buscarPerfil("tok", vi.fn().mockResolvedValue(respostaJson({}, 401)))).rejects.toBeInstanceOf(
            NaoAutenticadoError
        )
    })

    it("erro sem corpo JSON usa mensagem genérica", async () => {
        const buscar = vi.fn().mockResolvedValue(new Response("<html>502</html>", { status: 502 }))
        await expect(buscarPerfil("tok", buscar)).rejects.toThrow(/Não foi possível falar com o servidor/)
    })
})

describe("carregarConfig", () => {
    const valida = { userPoolId: "us-east-1_AbC123xyz", userPoolClientId: "1a2b3c4d5e6f7g8h9i0j1k2l3m" }

    it("aceita a config gerada pelo deploy", async () => {
        const buscar = vi.fn().mockResolvedValue(respostaJson({ ...valida, extra: "ignorado" }))
        expect(await carregarConfig(buscar)).toEqual(valida)
        expect(buscar.mock.calls[0]![0]).toBe("/config.json")
    })

    it.each([
        ["sem arquivo", respostaJson({}, 404)],
        ["sem userPoolId", respostaJson({ userPoolClientId: valida.userPoolClientId })],
        ["userPoolId inválido", respostaJson({ ...valida, userPoolId: "abc" })],
        ["clientId inválido", respostaJson({ ...valida, userPoolClientId: "<script>" })],
    ])("recusa config inválida (%s)", async (_caso, resposta) => {
        await expect(carregarConfig(vi.fn().mockResolvedValue(resposta))).rejects.toThrow()
    })
})
