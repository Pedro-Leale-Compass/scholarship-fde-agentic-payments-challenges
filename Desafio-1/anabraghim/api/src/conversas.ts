// GET /conversas — histórico do usuário autenticado, só o que a tela exibe.
//
// Resposta: { "mensagens": [ { "papel": "usuario" | "assistente", "texto": "...", "criado_em": "..." } ] }
// Chamadas e resultados de tools ficam gravados para o agente, mas não aparecem aqui.
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda"
import { carregarMensagens, type Mensagem } from "./shared/conversas"
import { MENSAGEM_FALHA, respostaJson, usuarioDoEvento } from "./shared/http"

export interface MensagemExibida {
    papel: "usuario" | "assistente"
    texto: string
    criado_em?: string
}

export function paraExibicao(mensagens: (Mensagem & { criado_em?: string })[]): MensagemExibida[] {
    const exibidas: MensagemExibida[] = []
    for (const mensagem of mensagens) {
        const texto = mensagem.content
            .map((bloco) => (typeof bloco.text === "string" ? bloco.text : ""))
            .filter((parte) => parte.trim() !== "")
            .join("\n")
        if (texto === "") continue // toolUse, toolResult ou só raciocínio
        exibidas.push({
            papel: mensagem.role === "user" ? "usuario" : "assistente",
            texto,
            ...(mensagem.criado_em ? { criado_em: mensagem.criado_em } : {}),
        })
    }
    return exibidas
}

export async function handler(evento: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
    const usuarioId = usuarioDoEvento(evento)
    if (!usuarioId) return respostaJson(401, { erro: "Não autenticado." })
    try {
        return respostaJson(200, { mensagens: paraExibicao(await carregarMensagens(usuarioId)) })
    } catch (error) {
        console.error("[conversas] falha ao ler o histórico", error)
        return respostaJson(500, { erro: MENSAGEM_FALHA })
    }
}
