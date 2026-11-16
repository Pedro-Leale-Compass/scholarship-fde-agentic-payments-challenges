import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createDocClient, requireEnv } from './shared/dynamo.ts'
import { RequisicaoInvalida, UsuarioNaoAutenticado, parseConversaId, parseUsuario } from './shared/requisicao.ts'
import { getConversa, listConversas, type Mensagem } from './shared/conversas.ts'

export const MENSAGEM_ERRO = 'Não foi possível carregar as conversas agora. Tente novamente em instantes.'

export type ToolExecutada = { nome: string; argumentos: unknown; resultado: unknown }

export type ItemHistorico =
  | { tipo: 'usuario'; texto: string }
  | { tipo: 'agente'; texto: string; tools: ToolExecutada[] }

export type DependenciasConversas = {
  db: DynamoDBDocumentClient
  tabelaConversas: string
  origem: string
}

function createResposta(statusCode: number, corpo: unknown, origem: string): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': origem,
      Vary: 'Origin',
    },
    body: JSON.stringify(corpo),
  }
}

function isObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
}

function parseResultado(conteudo: unknown): unknown {
  if (!Array.isArray(conteudo)) return null
  const texto = conteudo.map((bloco) => (isObjeto(bloco) && typeof bloco.text === 'string' ? bloco.text : '')).join('')
  try {
    return JSON.parse(texto)
  } catch {
    return texto
  }
}

export function formatHistorico(mensagens: Mensagem[]): ItemHistorico[] {
  const historico: ItemHistorico[] = []
  const tools = new Map<string, ToolExecutada>()

  const getAgente = () => {
    const ultimo = historico.at(-1)
    if (ultimo?.tipo === 'agente') return ultimo
    const novo: ItemHistorico = { tipo: 'agente', texto: '', tools: [] }
    historico.push(novo)
    return novo
  }

  for (const mensagem of mensagens) {
    for (const bloco of mensagem.content) {
      if (mensagem.role === 'user' && typeof bloco.text === 'string') {
        historico.push({ tipo: 'usuario', texto: bloco.text })
      } else if (mensagem.role === 'assistant' && typeof bloco.text === 'string' && bloco.text.trim()) {
        const agente = getAgente()
        agente.texto = agente.texto ? `${agente.texto}\n\n${bloco.text}` : bloco.text
      } else if (mensagem.role === 'assistant' && isObjeto(bloco.toolUse)) {
        const tool: ToolExecutada = {
          nome: String(bloco.toolUse.name),
          argumentos: bloco.toolUse.input ?? {},
          resultado: null,
        }
        tools.set(String(bloco.toolUse.toolUseId), tool)
        getAgente().tools.push(tool)
      } else if (mensagem.role === 'user' && isObjeto(bloco.toolResult)) {
        const tool = tools.get(String(bloco.toolResult.toolUseId))
        if (tool) tool.resultado = parseResultado(bloco.toolResult.content)
      }
    }
  }

  return historico
}

export async function handleConversas(
  evento: Pick<APIGatewayProxyEvent, 'requestContext' | 'pathParameters'>,
  deps: DependenciasConversas,
): Promise<APIGatewayProxyResult> {
  try {
    const usuarioId = parseUsuario(evento)
    const id = evento.pathParameters?.id

    if (id === undefined) {
      const conversas = await listConversas(deps.db, deps.tabelaConversas, usuarioId)
      return createResposta(200, { conversas }, deps.origem)
    }

    const conversa = await getConversa(deps.db, deps.tabelaConversas, usuarioId, parseConversaId(id))
    if (!conversa) return createResposta(404, { erro: 'conversa não encontrada' }, deps.origem)

    return createResposta(
      200,
      {
        conversa_id: conversa.conversa_id,
        titulo: conversa.titulo,
        criada_em: conversa.criada_em,
        atualizada_em: conversa.atualizada_em,
        historico: formatHistorico(conversa.mensagens),
      },
      deps.origem,
    )
  } catch (erro) {
    if (erro instanceof UsuarioNaoAutenticado) return createResposta(401, { erro: 'não autenticado' }, deps.origem)
    if (erro instanceof RequisicaoInvalida) return createResposta(400, { erro: erro.message }, deps.origem)
    console.error(
      JSON.stringify({
        contexto: 'list_conversas',
        erro: erro instanceof Error ? { nome: erro.name, mensagem: erro.message } : String(erro),
      }),
    )
    return createResposta(500, { erro: MENSAGEM_ERRO }, deps.origem)
  }
}

const db = createDocClient()

export async function handler(evento: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const origem = process.env.ORIGEM_PERMITIDA?.trim() ?? ''
  let tabelaConversas: string
  try {
    tabelaConversas = requireEnv('TABELA_CONVERSAS')
    requireEnv('ORIGEM_PERMITIDA')
  } catch (erro) {
    console.error(JSON.stringify({ contexto: 'configuracao', erro: String(erro) }))
    return createResposta(500, { erro: MENSAGEM_ERRO }, origem)
  }
  return handleConversas(evento, { db, tabelaConversas, origem })
}
