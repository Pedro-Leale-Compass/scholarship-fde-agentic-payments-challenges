export type EventoTool = {
  usuario_id?: unknown
  conversa_id?: unknown
  argumentos?: unknown
}

export class ContextoInvalido extends Error {
  override name = 'ContextoInvalido'
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function parseUsuario(evento: EventoTool): string {
  const valor = typeof evento.usuario_id === 'string' ? evento.usuario_id.trim() : ''
  if (!valor || valor.length > 128) throw new ContextoInvalido('usuario_id ausente ou inválido')
  return valor
}

export function parseConversa(evento: EventoTool): string {
  const valor = typeof evento.conversa_id === 'string' ? evento.conversa_id.trim() : ''
  if (!UUID_V4.test(valor)) throw new ContextoInvalido('conversa_id ausente ou inválido')
  return valor.toLowerCase()
}

export function parseArgumentos(evento: EventoTool): Record<string, unknown> {
  const args = evento.argumentos
  return typeof args === 'object' && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {}
}
