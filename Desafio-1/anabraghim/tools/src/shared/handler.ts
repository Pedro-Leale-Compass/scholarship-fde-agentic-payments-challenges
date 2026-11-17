import { recusar, type Recusa } from "./respostas"

// Evento enviado pelo agente no AgentCore Runtime. O usuario_id é injetado pelo
// código do agente a partir da sessão autenticada (sub do Cognito), fora dos
// argumentos que o modelo preenche, então o modelo não consegue forjá-lo.
export interface EventoTool {
    usuario_id?: unknown
    argumentos?: unknown
}

export interface ContextoTool {
    usuarioId: string | null
    argumentos: Record<string, unknown>
}

// Ids do sistema são UUIDs. Mesma regra do z.guid() da Fase 1: aceita qualquer
// UUID bem formado, sem exigir o nibble de versão do RFC 4122.
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function ehGuid(valor: unknown): valor is string {
    return typeof valor === "string" && GUID.test(valor)
}

function lerContexto(evento: EventoTool): ContextoTool {
    const usuarioId =
        typeof evento?.usuario_id === "string" && evento.usuario_id.trim() !== "" ? evento.usuario_id : null
    const argumentos =
        evento?.argumentos != null && typeof evento.argumentos === "object" && !Array.isArray(evento.argumentos)
            ? (evento.argumentos as Record<string, unknown>)
            : {}
    return { usuarioId, argumentos }
}

// Envolve a regra da tool: qualquer exceção inesperada (DynamoDB fora, bug, etc.)
// vira uma recusa compreensível, nunca um stack trace para o usuário. O detalhe
// fica só no CloudWatch Logs.
export function criarHandler<T>(nomeTool: string, executar: (ctx: ContextoTool) => Promise<T | Recusa>) {
    return async (evento: EventoTool): Promise<T | Recusa> => {
        try {
            return await executar(lerContexto(evento))
        } catch (error) {
            console.error(`[${nomeTool}] falha inesperada`, error)
            return recusar(
                "FALHA_NA_FERRAMENTA",
                "Não foi possível concluir a operação agora por uma falha interna. Tente novamente em instantes."
            )
        }
    }
}
