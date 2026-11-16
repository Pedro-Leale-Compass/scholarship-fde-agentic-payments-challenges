// Cliente da API. Todas as rotas ficam em /api na mesma origem do site (o
// CloudFront encaminha para o API Gateway), então não há CORS.
//
// O token é o ID token do Cognito: é o que o autorizador do API Gateway aceita e
// o único que traz a claim email usada pelo /api/perfil.
import type { EventoChat, MensagemHistorico, Perfil } from "../types"
import { lerNdjson } from "./ndjson"

// 401: sessão ausente, inválida ou expirada. Quem chama faz logout.
export class NaoAutenticadoError extends Error {
    constructor() {
        super("Sessão expirada ou inválida.")
    }
}

const FALHA_GENERICA = "Não foi possível falar com o servidor. Tente novamente em instantes."

async function erroDaResposta(resposta: Response): Promise<Error> {
    if (resposta.status === 401) return new NaoAutenticadoError()
    const corpo = (await resposta.json().catch(() => null)) as { erro?: unknown } | null
    return new Error(typeof corpo?.erro === "string" ? corpo.erro : FALHA_GENERICA)
}

async function getJson<T>(rota: string, token: string, buscar: typeof fetch): Promise<T> {
    const resposta = await buscar(rota, { headers: { Authorization: token }, cache: "no-store" })
    if (!resposta.ok) throw await erroDaResposta(resposta)
    return (await resposta.json()) as T
}

export async function buscarPerfil(token: string, buscar: typeof fetch = fetch): Promise<Perfil> {
    return getJson<Perfil>("/api/perfil", token, buscar)
}

export async function buscarConversas(token: string, buscar: typeof fetch = fetch): Promise<MensagemHistorico[]> {
    const { mensagens } = await getJson<{ mensagens?: MensagemHistorico[] }>("/api/conversas", token, buscar)
    return Array.isArray(mensagens) ? mensagens : []
}

function ehEventoChat(valor: unknown): valor is EventoChat {
    if (valor == null || typeof valor !== "object") return false
    const ev = valor as Record<string, unknown>
    switch (ev.tipo) {
        case "texto":
            return typeof ev.texto === "string"
        case "ferramenta":
            return typeof ev.nome === "string"
        case "fim":
            return true
        case "erro":
            return typeof ev.mensagem === "string"
        default:
            return false
    }
}

// Envia a mensagem e devolve os eventos conforme chegam. O histórico não vai no
// corpo: o servidor guarda a conversa e só aceita o texto novo.
export async function* enviarMensagem(
    mensagem: string,
    token: string,
    opcoes: { buscar?: typeof fetch; signal?: AbortSignal } = {}
): AsyncGenerator<EventoChat> {
    const buscar = opcoes.buscar ?? fetch
    const resposta = await buscar("/api/chat", {
        method: "POST",
        headers: { Authorization: token, "Content-Type": "application/json" },
        body: JSON.stringify({ mensagem }),
        signal: opcoes.signal,
    })
    if (!resposta.ok) throw await erroDaResposta(resposta)
    if (!resposta.body) throw new Error(FALHA_GENERICA)

    let terminou = false
    try {
        for await (const valor of lerNdjson(resposta.body)) {
            if (!ehEventoChat(valor)) continue
            yield valor
            if (valor.tipo === "fim" || valor.tipo === "erro") {
                terminou = true
                return
            }
        }
    } catch (erro) {
        if (erro instanceof DOMException && erro.name === "AbortError") throw erro
        // Conexão caiu ou linha corrompida no meio do stream.
    }
    if (!terminou) yield { tipo: "erro", mensagem: "A conexão foi interrompida antes do fim da resposta. Tente novamente." }
}
