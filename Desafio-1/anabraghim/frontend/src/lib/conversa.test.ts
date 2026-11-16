import { describe, expect, it } from "vitest"
import type { EventoChat } from "../types"
import { ESTADO_INICIAL, adicionarUsuario, aplicarEvento, historicoParaTela, rotuloFerramenta } from "./conversa"

function ids() {
    let n = 0
    return () => `id${++n}`
}

function aplicarTodos(eventos: EventoChat[]) {
    const novoId = ids()
    let estado = adicionarUsuario(ESTADO_INICIAL, "quero 2 fones", "u1")
    for (const evento of eventos) estado = aplicarEvento(estado, evento, novoId)
    return estado
}

describe("aplicarEvento", () => {
    it("acumula os pedaços de texto num único balão do assistente", () => {
        const estado = aplicarTodos([
            { tipo: "texto", texto: "Olá" },
            { tipo: "texto", texto: ", tudo bem?" },
            { tipo: "fim" },
        ])
        expect(estado.mensagens.map((m) => [m.papel, m.texto])).toEqual([
            ["usuario", "quero 2 fones"],
            ["assistente", "Olá, tudo bem?"],
        ])
        expect(estado.ferramenta).toBeNull()
    })

    it("texto depois de uma tool vai para um balão novo, como no histórico recarregado", () => {
        const estado = aplicarTodos([
            { tipo: "texto", texto: "Vou consultar." },
            { tipo: "ferramenta", nome: "listar_catalogo" },
            { tipo: "texto", texto: "Temos fones." },
            { tipo: "fim" },
        ])
        expect(estado.mensagens.map((m) => m.texto)).toEqual(["quero 2 fones", "Vou consultar.", "Temos fones."])
    })

    it("mostra a tool em execução até o próximo texto", () => {
        const novoId = ids()
        let estado = aplicarEvento(ESTADO_INICIAL, { tipo: "ferramenta", nome: "realizar_compra" }, novoId)
        expect(estado.ferramenta).toBe("realizar_compra")
        estado = aplicarEvento(estado, { tipo: "texto", texto: "Pago." }, novoId)
        expect(estado.ferramenta).toBeNull()
    })

    it("erro vira balão de aviso e limpa o indicador", () => {
        const estado = aplicarTodos([
            { tipo: "ferramenta", nome: "listar_catalogo" },
            { tipo: "erro", mensagem: "Tente novamente." },
        ])
        expect(estado.mensagens.at(-1)).toMatchObject({ papel: "erro", texto: "Tente novamente." })
        expect(estado.ferramenta).toBeNull()
    })

    it("um turno novo nunca continua o balão do turno anterior", () => {
        const novoId = ids()
        let estado = aplicarEvento(ESTADO_INICIAL, { tipo: "texto", texto: "Resposta 1" }, novoId)
        estado = adicionarUsuario(estado, "outra pergunta", "u2")
        estado = aplicarEvento(estado, { tipo: "texto", texto: "Resposta 2" }, novoId)
        expect(estado.mensagens.map((m) => m.texto)).toEqual(["Resposta 1", "outra pergunta", "Resposta 2"])
    })
})

describe("auxiliares", () => {
    it("converte o histórico do servidor com ids únicos", () => {
        const tela = historicoParaTela(
            [
                { papel: "usuario", texto: "oi" },
                { papel: "assistente", texto: "olá" },
            ],
            ids()
        )
        expect(tela).toEqual([
            { id: "id1", papel: "usuario", texto: "oi" },
            { id: "id2", papel: "assistente", texto: "olá" },
        ])
    })

    it("rótulos das tools em português, com padrão para tools novas", () => {
        expect(rotuloFerramenta("listar_catalogo")).toBe("consultando o catálogo…")
        expect(rotuloFerramenta("outra")).toBe("consultando…")
    })
})
