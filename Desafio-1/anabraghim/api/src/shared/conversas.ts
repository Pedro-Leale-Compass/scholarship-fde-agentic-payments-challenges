import { randomUUID } from "node:crypto"
import { QueryCommand, TransactWriteCommand, type QueryCommandOutput } from "@aws-sdk/lib-dynamodb"
import { configuracao, ddb } from "./ddb"

// Mensagem no formato do Strands/Bedrock, exatamente como o agente devolveu no
// evento "fim": { role, content: [ {text} | {toolUse} | {toolResult} | {reasoningContent} ] }.
export interface Mensagem {
    role: "user" | "assistant"
    content: Record<string, unknown>[]
}

// O agente aceita até 400 mensagens, contando a nova. Ver agent/agente/payload.py.
export const MAX_HISTORICO = 399

// Um item por mensagem. A SK ordena por início do turno, depois por turno e por
// posição dentro dele: dois turnos simultâneos (duas abas) ficam em blocos
// separados, cada um começando no usuário e terminando no assistente.
export function chaveDaMensagem(inicio: Date, turno: string, posicao: number): string {
    return `msg#${inicio.toISOString()}#${turno}#${String(posicao).padStart(3, "0")}`
}

function ehMensagem(valor: unknown): valor is Mensagem {
    if (valor == null || typeof valor !== "object") return false
    const { role, content } = valor as Record<string, unknown>
    return (role === "user" || role === "assistant") && Array.isArray(content) && content.length > 0
}

// Mensagem do usuário que abre um turno: só texto (um toolResult também tem role "user").
function abreTurno(mensagem: Mensagem): boolean {
    return mensagem.role === "user" && mensagem.content.every((bloco) => typeof bloco.text === "string")
}

// Lê as mensagens mais recentes (até `limite`), em ordem cronológica.
export async function carregarMensagens(
    usuarioId: string,
    limite = MAX_HISTORICO
): Promise<(Mensagem & { criado_em?: string })[]> {
    const itens: Record<string, unknown>[] = []
    let inicio: QueryCommandOutput["LastEvaluatedKey"]
    do {
        const pagina: QueryCommandOutput = await ddb.send(
            new QueryCommand({
                TableName: configuracao("TABELA_CONVERSAS"),
                KeyConditionExpression: "usuario_id = :usuario AND begins_with(sk, :prefixo)",
                ExpressionAttributeValues: { ":usuario": usuarioId, ":prefixo": "msg#" },
                ScanIndexForward: false,
                ConsistentRead: true,
                Limit: limite - itens.length,
                ExclusiveStartKey: inicio,
            })
        )
        itens.push(...(pagina.Items ?? []))
        inicio = pagina.LastEvaluatedKey
    } while (inicio && itens.length < limite)

    return itens
        .reverse()
        .filter(ehMensagem)
        .map((item) => ({
            role: item.role as Mensagem["role"],
            content: item.content as Mensagem["content"],
            ...(typeof item.criado_em === "string" ? { criado_em: item.criado_em } : {}),
        }))
}

// Garante que o histórico enviado ao agente começa num turno completo: se o corte
// por limite caiu no meio de um turno (ex.: num toolResult), descarta até o
// próximo texto do usuário. Sem isso o Bedrock rejeitaria a conversa.
export function aPartirDoPrimeiroTurno(mensagens: Mensagem[]): Mensagem[] {
    const inicio = mensagens.findIndex(abreTurno)
    return inicio === -1 ? [] : mensagens.slice(inicio)
}

export async function carregarHistorico(usuarioId: string): Promise<Mensagem[]> {
    const mensagens = await carregarMensagens(usuarioId)
    return aPartirDoPrimeiroTurno(mensagens.map(({ role, content }) => ({ role, content })))
}

// Valida as mensagens_novas devolvidas pelo agente: começam no texto do usuário e
// terminam no assistente. Qualquer outra coisa não é gravada.
export function validarTurno(valor: unknown): Mensagem[] | null {
    if (!Array.isArray(valor) || valor.length < 2 || valor.length > 100) return null
    if (!valor.every(ehMensagem)) return null
    const primeira = valor[0]
    const ultima = valor[valor.length - 1]
    if (!primeira || !ultima || !abreTurno(primeira) || ultima.role !== "assistant") return null
    return valor
}

// Grava o turno inteiro numa transação: ou entra tudo, ou nada (o histórico nunca
// fica com um toolUse sem toolResult).
export async function salvarTurno(usuarioId: string, mensagens: Mensagem[], inicio: Date): Promise<void> {
    const turno = randomUUID().slice(0, 8)
    const criadoEm = new Date().toISOString()
    await ddb.send(
        new TransactWriteCommand({
            TransactItems: mensagens.map((mensagem, posicao) => ({
                Put: {
                    TableName: configuracao("TABELA_CONVERSAS"),
                    Item: {
                        usuario_id: usuarioId,
                        sk: chaveDaMensagem(inicio, turno, posicao),
                        role: mensagem.role,
                        content: mensagem.content,
                        criado_em: criadoEm,
                    },
                    ConditionExpression: "attribute_not_exists(sk)",
                },
            })),
        })
    )
}
