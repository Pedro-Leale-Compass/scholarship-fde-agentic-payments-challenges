/// <reference types="aws-lambda" />
// POST /chat — Lambda com response streaming atrás do API Gateway REST.
//
// Corpo: { "mensagem": "texto do usuário" }
// Resposta: 200 com NDJSON (uma linha JSON por evento), em tempo real:
//   {"tipo":"texto","texto":"..."}        pedaço da resposta do assistente
//   {"tipo":"ferramenta","nome":"..."}    o agente está consultando uma tool
//   {"tipo":"fim"}                        turno concluído e gravado no histórico
//   {"tipo":"erro","mensagem":"..."}      turno não concluído; nada foi gravado
//   {"tipo":"pulso"}                      a cada 15 s, só para manter a conexão viva
// Erros antes do stream (401, 400, 502) voltam como JSON { erro }.
import type { APIGatewayProxyEvent } from "aws-lambda"
import type { Writable } from "node:stream"
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore"
import { carregarHistorico, salvarTurno, validarTurno, type Mensagem } from "./shared/conversas"
import { configuracao } from "./shared/ddb"
import { MENSAGEM_FALHA, usuarioDoEvento } from "./shared/http"
import { lerEventosSse } from "./shared/sse"

export const MAX_CARACTERES_MENSAGEM = 4000
export const MENSAGEM_NAO_SALVA =
    "A resposta foi gerada, mas não consegui salvá-la no histórico. Se algo não aparecer depois de recarregar, repita o pedido."

const agentcore = new BedrockAgentCoreClient({})

type Saida = Writable

function abrirStream(responseStream: Writable, statusCode: number, contentType: string): Saida {
    return awslambda.HttpResponseStream.from(responseStream, {
        statusCode,
        headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
    })
}

function responderErro(responseStream: Writable, statusCode: number, erro: string): void {
    const saida = abrirStream(responseStream, statusCode, "application/json; charset=utf-8")
    saida.write(JSON.stringify({ erro }))
    saida.end()
}

function escrever(saida: Saida, evento: Record<string, unknown>): void {
    saida.write(`${JSON.stringify(evento)}\n`)
}

export function lerMensagem(evento: APIGatewayProxyEvent): string | null {
    if (!evento.body) return null
    try {
        const texto = evento.isBase64Encoded ? Buffer.from(evento.body, "base64").toString("utf-8") : evento.body
        const corpo: unknown = JSON.parse(texto)
        const mensagem = (corpo as { mensagem?: unknown } | null)?.mensagem
        if (typeof mensagem !== "string") return null
        const limpa = mensagem.trim()
        return limpa !== "" && limpa.length <= MAX_CARACTERES_MENSAGEM ? limpa : null
    } catch {
        return null
    }
}

// Uma sessão do AgentCore por usuário: a microVM nunca é compartilhada entre
// usuários. O id precisa ter pelo menos 33 caracteres (o sub tem 36).
export function sessaoDoUsuario(usuarioId: string): string {
    return `sessao-${usuarioId}`
}

// O CloudFront corta a resposta se a origem ficar mais de 60 s sem mandar bytes
// (OriginReadTimeout). Enquanto o agente pensa ou chama tools, um "pulso" mantém
// a conexão viva; o frontend ignora esse evento.
export const INTERVALO_PULSO_MS = 15_000

export async function processarChat(
    evento: APIGatewayProxyEvent,
    responseStream: Writable,
    opcoes: { intervaloPulsoMs?: number } = {}
): Promise<void> {
    const usuarioId = usuarioDoEvento(evento)
    if (!usuarioId) return responderErro(responseStream, 401, "Não autenticado.")

    const mensagem = lerMensagem(evento)
    if (!mensagem) {
        return responderErro(
            responseStream,
            400,
            `Envie { "mensagem": "..." } com texto de 1 a ${MAX_CARACTERES_MENSAGEM} caracteres.`
        )
    }

    const inicio = new Date()
    let corpoDoAgente: AsyncIterable<Uint8Array>
    try {
        const historico = await carregarHistorico(usuarioId)
        const mensagens: Mensagem[] = [...historico, { role: "user", content: [{ text: mensagem }] }]
        const resposta = await agentcore.send(
            new InvokeAgentRuntimeCommand({
                agentRuntimeArn: configuracao("AGENTE_RUNTIME_ARN"),
                qualifier: "DEFAULT",
                runtimeSessionId: sessaoDoUsuario(usuarioId),
                contentType: "application/json",
                accept: "text/event-stream",
                payload: new TextEncoder().encode(JSON.stringify({ usuario_id: usuarioId, mensagens })),
            })
        )
        if (!resposta.response) throw new Error("AgentCore respondeu sem corpo")
        corpoDoAgente = resposta.response as AsyncIterable<Uint8Array>
    } catch (error) {
        console.error("[chat] falha antes do stream", error)
        return responderErro(responseStream, 502, MENSAGEM_FALHA)
    }

    const saida = abrirStream(responseStream, 200, "application/x-ndjson; charset=utf-8")
    const pulso = setInterval(() => escrever(saida, { tipo: "pulso" }), opcoes.intervaloPulsoMs ?? INTERVALO_PULSO_MS)
    let concluido = false
    try {
        for await (const bruto of lerEventosSse(corpoDoAgente)) {
            const ev = (bruto ?? {}) as Record<string, unknown>
            if (ev.tipo === "texto" && typeof ev.texto === "string") {
                escrever(saida, { tipo: "texto", texto: ev.texto })
            } else if (ev.tipo === "ferramenta" && typeof ev.nome === "string") {
                escrever(saida, { tipo: "ferramenta", nome: ev.nome })
            } else if (ev.tipo === "fim") {
                const turno = validarTurno(ev.mensagens_novas)
                if (!turno) {
                    console.error("[chat] evento fim fora do formato esperado")
                    escrever(saida, { tipo: "erro", mensagem: MENSAGEM_FALHA })
                } else {
                    try {
                        await salvarTurno(usuarioId, turno, inicio)
                        escrever(saida, { tipo: "fim" })
                    } catch (error) {
                        console.error("[chat] falha ao gravar o turno", error)
                        escrever(saida, { tipo: "erro", mensagem: MENSAGEM_NAO_SALVA })
                    }
                }
                concluido = true
                break
            } else if (ev.tipo === "erro") {
                // As mensagens de erro do agente já são amigáveis; ainda assim, só texto curto passa.
                const texto = typeof ev.mensagem === "string" && ev.mensagem.length <= 500 ? ev.mensagem : MENSAGEM_FALHA
                escrever(saida, { tipo: "erro", mensagem: texto })
                concluido = true
                break
            } else if ("error" in ev) {
                // Erro do próprio BedrockAgentCoreApp (exceção fora do nosso tratamento).
                console.error("[chat] erro do runtime", ev)
                escrever(saida, { tipo: "erro", mensagem: MENSAGEM_FALHA })
                concluido = true
                break
            }
        }
        if (!concluido) {
            console.error("[chat] stream do agente terminou sem fim")
            escrever(saida, { tipo: "erro", mensagem: MENSAGEM_FALHA })
        }
    } catch (error) {
        console.error("[chat] falha durante o stream", error)
        escrever(saida, { tipo: "erro", mensagem: MENSAGEM_FALHA })
    }
    clearInterval(pulso)
    saida.end()
}

// O runtime chama o handler com (evento, stream, context): o context não pode cair
// no parâmetro de opções.
export const handler = awslambda.streamifyResponse((evento: APIGatewayProxyEvent, responseStream: Writable) =>
    processarChat(evento, responseStream)
)
