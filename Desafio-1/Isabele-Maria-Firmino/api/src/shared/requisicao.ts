import type { APIGatewayProxyEvent } from 'aws-lambda'

export class UsuarioNaoAutenticado extends Error {
  override name = 'UsuarioNaoAutenticado'
}

export class RequisicaoInvalida extends Error {
  override name = 'RequisicaoInvalida'
}

export const TAMANHO_MAXIMO_MENSAGEM = 2000

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type CorpoChat = { conversaId: string; mensagem: string }

export function parseUsuario(evento: Pick<APIGatewayProxyEvent, 'requestContext'>): string {
  const claims = evento.requestContext?.authorizer?.claims as Record<string, unknown> | undefined
  const sub = typeof claims?.sub === 'string' ? claims.sub.trim() : ''
  if (!sub) throw new UsuarioNaoAutenticado('claim sub ausente')
  return sub
}

export function parseConversaId(valor: unknown): string {
  const conversaId = typeof valor === 'string' ? valor.trim() : ''
  if (!UUID_V4.test(conversaId)) throw new RequisicaoInvalida('conversa_id deve ser um UUID v4')
  return conversaId.toLowerCase()
}

export function parseCorpoChat(evento: Pick<APIGatewayProxyEvent, 'body' | 'isBase64Encoded'>): CorpoChat {
  if (!evento.body) throw new RequisicaoInvalida('corpo da requisição ausente')

  const texto = evento.isBase64Encoded ? Buffer.from(evento.body, 'base64').toString('utf8') : evento.body

  let corpo: unknown
  try {
    corpo = JSON.parse(texto)
  } catch {
    throw new RequisicaoInvalida('corpo da requisição não é um JSON válido')
  }
  if (typeof corpo !== 'object' || corpo === null || Array.isArray(corpo)) {
    throw new RequisicaoInvalida('corpo da requisição deve ser um objeto')
  }

  const campos = corpo as Record<string, unknown>
  const conversaId = parseConversaId(campos.conversa_id)

  const mensagem = typeof campos.mensagem === 'string' ? campos.mensagem.trim() : ''
  if (!mensagem || mensagem.length > TAMANHO_MAXIMO_MENSAGEM) {
    throw new RequisicaoInvalida(`mensagem deve ter entre 1 e ${TAMANHO_MAXIMO_MENSAGEM} caracteres`)
  }

  return { conversaId, mensagem }
}
