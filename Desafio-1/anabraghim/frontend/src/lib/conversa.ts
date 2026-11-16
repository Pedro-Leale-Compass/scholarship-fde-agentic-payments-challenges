// Como cada evento do stream muda a tela. Funções puras, testadas sem React.
import type { EventoChat, MensagemHistorico, MensagemTela } from "../types"

export const ROTULOS_FERRAMENTA: Record<string, string> = {
    listar_catalogo: "consultando o catálogo…",
    registrar_intencao: "registrando a intenção de compra…",
    realizar_compra: "processando o pagamento…",
}

export function rotuloFerramenta(nome: string): string {
    return ROTULOS_FERRAMENTA[nome] ?? "consultando…"
}

export interface EstadoConversa {
    mensagens: MensagemTela[]
    // Tool em execução no momento (para o indicador "consultando o catálogo…").
    ferramenta: string | null
    // Depois de uma tool, o texto seguinte vai para um balão novo, igual ao que o
    // GET /api/conversas devolve ao recarregar a página.
    novaBolha: boolean
}

export const ESTADO_INICIAL: EstadoConversa = { mensagens: [], ferramenta: null, novaBolha: false }

export function historicoParaTela(historico: MensagemHistorico[], novoId: () => string): MensagemTela[] {
    return historico.map((m) => ({ id: novoId(), papel: m.papel, texto: m.texto }))
}

export function adicionarUsuario(estado: EstadoConversa, texto: string, id: string): EstadoConversa {
    return { mensagens: [...estado.mensagens, { id, papel: "usuario", texto }], ferramenta: null, novaBolha: false }
}

export function aplicarEvento(estado: EstadoConversa, evento: EventoChat, novoId: () => string): EstadoConversa {
    switch (evento.tipo) {
        case "texto": {
            const ultima = estado.mensagens.at(-1)
            if (!estado.novaBolha && ultima?.papel === "assistente") {
                const atualizada = { ...ultima, texto: ultima.texto + evento.texto }
                return { mensagens: [...estado.mensagens.slice(0, -1), atualizada], ferramenta: null, novaBolha: false }
            }
            return {
                mensagens: [...estado.mensagens, { id: novoId(), papel: "assistente", texto: evento.texto }],
                ferramenta: null,
                novaBolha: false,
            }
        }
        case "ferramenta":
            return { ...estado, ferramenta: evento.nome, novaBolha: true }
        case "fim":
            return { ...estado, ferramenta: null, novaBolha: false }
        case "erro":
            return {
                mensagens: [...estado.mensagens, { id: novoId(), papel: "erro", texto: evento.mensagem }],
                ferramenta: null,
                novaBolha: false,
            }
    }
}
