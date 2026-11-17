// Contratos da API (ver api/README.md).

export type Papel = "usuario" | "assistente"

// GET /api/conversas
export interface MensagemHistorico {
    papel: Papel
    texto: string
    criado_em?: string
}

// GET /api/perfil
export interface Perfil {
    email: string | null
    limite_total: number
    limite_disponivel: number
    moeda: string
}

// POST /api/chat: uma linha NDJSON por evento.
export type EventoChat =
    | { tipo: "texto"; texto: string }
    | { tipo: "ferramenta"; nome: string }
    | { tipo: "fim" }
    | { tipo: "erro"; mensagem: string }

// O que a tela exibe. "erro" é um balão de aviso (turno não concluído).
export interface MensagemTela {
    id: string
    papel: Papel | "erro"
    texto: string
}
