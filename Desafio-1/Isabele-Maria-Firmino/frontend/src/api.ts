import { fetchAuthSession } from 'aws-amplify/auth'
import type { ConfigApp } from './config.ts'

export type ToolExecutada = { nome: string; argumentos: unknown; resultado: unknown }

export type ItemHistorico =
  | { tipo: 'usuario'; texto: string }
  | { tipo: 'agente'; texto: string; tools: ToolExecutada[] }

export type ResumoConversa = {
  conversa_id: string
  titulo: string
  criada_em: string
  atualizada_em: string
}

export type DetalheConversa = ResumoConversa & { historico: ItemHistorico[] }

export type EventoChat =
  | { tipo: 'texto'; texto: string }
  | { tipo: 'tool'; nome: string; argumentos: unknown; resultado: unknown }
  | { tipo: 'erro'; mensagem: string }
  | { tipo: 'fim' }

export const PREFIXO_TOKEN = 'Bearer '

export const MENSAGEM_SEM_CONEXAO = 'Não foi possível conectar ao servidor. Verifique sua conexão.'
export const MENSAGEM_SESSAO_EXPIRADA = 'Sua sessão expirou. Faça login novamente.'
export const MENSAGEM_NAO_ENCONTRADA = 'Conversa não encontrada.'
export const MENSAGEM_MUITAS_REQUISICOES = 'Muitas mensagens em pouco tempo. Aguarde alguns segundos e tente de novo.'
export const MENSAGEM_PADRAO = 'Não foi possível falar com o servidor agora. Tente novamente em instantes.'

const TIPOS_EVENTO = new Set(['texto', 'tool', 'erro', 'fim'])

export class ErroApi extends Error {
  override name = 'ErroApi'
  readonly status: number

  constructor(status: number, mensagem: string) {
    super(mensagem)
    this.status = status
  }
}

export function getMensagemStatus(status: number, mensagemServidor?: string): string {
  if (status === 0) return MENSAGEM_SEM_CONEXAO
  if (status === 401 || status === 403) return MENSAGEM_SESSAO_EXPIRADA
  if (status === 404) return MENSAGEM_NAO_ENCONTRADA
  if (status === 429) return MENSAGEM_MUITAS_REQUISICOES
  if (status === 400 && mensagemServidor) return mensagemServidor
  return MENSAGEM_PADRAO
}

export function isEventoChat(valor: unknown): valor is EventoChat {
  if (typeof valor !== 'object' || valor === null) return false
  const tipo = (valor as Record<string, unknown>).tipo
  return typeof tipo === 'string' && TIPOS_EVENTO.has(tipo)
}

export function parseNdjson(acumulado: string): { linhas: unknown[]; resto: string } {
  const partes = acumulado.split('\n')
  const resto = partes.pop() ?? ''
  const linhas = partes.filter((linha) => linha.trim()).map((linha) => JSON.parse(linha) as unknown)
  return { linhas, resto }
}

export async function getIdToken(): Promise<string> {
  const sessao = await fetchAuthSession()
  const token = sessao.tokens?.idToken?.toString()
  if (!token) throw new ErroApi(401, MENSAGEM_SESSAO_EXPIRADA)
  return token
}

async function createErroApi(resposta: Response): Promise<ErroApi> {
  let mensagemServidor: string | undefined
  try {
    const corpo = (await resposta.json()) as Record<string, unknown>
    if (typeof corpo.erro === 'string') mensagemServidor = corpo.erro
  } catch {
    mensagemServidor = undefined
  }
  return new ErroApi(resposta.status, getMensagemStatus(resposta.status, mensagemServidor))
}

async function sendRequisicao(config: ConfigApp, caminho: string, init: RequestInit = {}): Promise<Response> {
  const token = await getIdToken()

  let resposta: Response
  try {
    resposta = await fetch(new URL(caminho, config.urlApi), {
      ...init,
      headers: { ...init.headers, Authorization: `${PREFIXO_TOKEN}${token}` },
    })
  } catch (erro) {
    if (erro instanceof DOMException && erro.name === 'AbortError') throw erro
    throw new ErroApi(0, MENSAGEM_SEM_CONEXAO)
  }

  if (!resposta.ok) throw await createErroApi(resposta)
  return resposta
}

export async function* streamChat(
  config: ConfigApp,
  conversaId: string,
  mensagem: string,
  signal?: AbortSignal,
): AsyncGenerator<EventoChat> {
  const resposta = await sendRequisicao(config, 'chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversa_id: conversaId, mensagem }),
    signal,
  })
  if (!resposta.body) throw new ErroApi(0, MENSAGEM_PADRAO)

  const leitor = resposta.body.pipeThrough(new TextDecoderStream()).getReader()
  let resto = ''

  for (;;) {
    const { value, done } = await leitor.read()
    if (done) break
    const lido = parseNdjson(resto + value)
    resto = lido.resto
    for (const evento of lido.linhas) if (isEventoChat(evento)) yield evento
  }

  for (const evento of parseNdjson(`${resto}\n`).linhas) if (isEventoChat(evento)) yield evento
}

export async function listConversas(config: ConfigApp): Promise<ResumoConversa[]> {
  const resposta = await sendRequisicao(config, 'conversas')
  const corpo = (await resposta.json()) as { conversas?: ResumoConversa[] }
  return corpo.conversas ?? []
}

export async function getConversa(config: ConfigApp, conversaId: string): Promise<DetalheConversa> {
  const resposta = await sendRequisicao(config, `conversas/${encodeURIComponent(conversaId)}`)
  return (await resposta.json()) as DetalheConversa
}
