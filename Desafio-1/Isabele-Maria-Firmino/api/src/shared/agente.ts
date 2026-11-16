import { createHash } from 'node:crypto'
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore'
import type { Mensagem } from './conversas.ts'

export type PayloadAgente = {
  usuario_id: string
  conversa_id: string
  mensagens: Mensagem[]
}

export type EventoAgente =
  | { tipo: 'texto'; texto: string }
  | { tipo: 'tool'; nome: string; argumentos: unknown; resultado: unknown }
  | { tipo: 'fim'; mensagens: Mensagem[] }
  | { tipo: 'erro'; mensagem: string }

const TIPOS_EVENTO = new Set(['texto', 'tool', 'fim', 'erro'])

export function createAgenteClient(): BedrockAgentCoreClient {
  return new BedrockAgentCoreClient({})
}

export function createRuntimeSessionId(usuarioId: string, conversaId: string): string {
  return createHash('sha256').update(`${usuarioId}:${conversaId}`).digest('hex')
}

export function isEventoAgente(valor: unknown): valor is EventoAgente {
  if (typeof valor !== 'object' || valor === null) return false
  const tipo = (valor as Record<string, unknown>).tipo
  return typeof tipo === 'string' && TIPOS_EVENTO.has(tipo)
}

function parseBlocoSse(bloco: string): unknown {
  const dados = bloco
    .split('\n')
    .filter((linha) => linha.startsWith('data:'))
    .map((linha) => linha.slice('data:'.length).replace(/^ /, ''))
  if (dados.length === 0) return undefined
  return JSON.parse(dados.join('\n'))
}

export async function* parseEventosSse(pedacos: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const pedaco of pedacos) {
    buffer = (buffer + decoder.decode(pedaco, { stream: true })).replace(/\r\n/g, '\n')

    let fim = buffer.indexOf('\n\n')
    while (fim !== -1) {
      const evento = parseBlocoSse(buffer.slice(0, fim))
      buffer = buffer.slice(fim + 2)
      if (evento !== undefined) yield evento
      fim = buffer.indexOf('\n\n')
    }
  }

  buffer = (buffer + decoder.decode()).replace(/\r\n/g, '\n')
  if (buffer.trim()) {
    const evento = parseBlocoSse(buffer)
    if (evento !== undefined) yield evento
  }
}

export async function* invokeAgente(
  client: BedrockAgentCoreClient,
  agentRuntimeArn: string,
  payload: PayloadAgente,
): AsyncGenerator<EventoAgente> {
  const resposta = await client.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn,
      runtimeSessionId: createRuntimeSessionId(payload.usuario_id, payload.conversa_id),
      contentType: 'application/json',
      accept: 'text/event-stream',
      payload: new TextEncoder().encode(JSON.stringify(payload)),
    }),
  )

  if (!resposta.response) throw new Error('resposta do agente vazia')
  if (!resposta.contentType?.includes('text/event-stream')) {
    throw new Error(`tipo de resposta inesperado do agente: ${resposta.contentType}`)
  }

  const pedacos = resposta.response as unknown as AsyncIterable<Uint8Array>
  for await (const valor of parseEventosSse(pedacos)) {
    if (isEventoAgente(valor)) yield valor
  }
}
