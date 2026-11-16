import type { Writable } from 'node:stream'
import type { APIGatewayProxyEvent } from 'aws-lambda'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createDocClient, requireEnv } from './shared/dynamo.ts'
import { RequisicaoInvalida, UsuarioNaoAutenticado, parseCorpoChat, parseUsuario } from './shared/requisicao.ts'
import { ConversaConcorrente, appendMensagens, createTitulo, getConversa, type Mensagem } from './shared/conversas.ts'
import { createAgenteClient, invokeAgente, type EventoAgente, type PayloadAgente } from './shared/agente.ts'

export const MENSAGEM_ERRO = 'Não consegui responder agora. Tente novamente em instantes.'
export const MENSAGEM_CONCORRENTE = 'Esta conversa foi atualizada em outra aba. Recarregue a página para continuar.'

export type DependenciasChat = {
  db: DynamoDBDocumentClient
  tabelaConversas: string
  invokeAgente: (payload: PayloadAgente) => AsyncIterable<EventoAgente>
}

export type OpenResposta = (statusCode: number) => Writable

export function createHeaders(origem: string): Record<string, string> {
  return {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': origem,
    Vary: 'Origin',
  }
}

function endStream(saida: Writable, texto?: string): Promise<void> {
  return new Promise((resolve) => {
    if (texto === undefined) saida.end(resolve)
    else saida.end(texto, resolve)
  })
}

function logErro(contexto: string, erro: unknown): void {
  console.error(
    JSON.stringify({
      contexto,
      erro: erro instanceof Error ? { nome: erro.name, mensagem: erro.message } : String(erro),
    }),
  )
}

export async function streamChat(
  evento: Pick<APIGatewayProxyEvent, 'requestContext' | 'body' | 'isBase64Encoded'>,
  open: OpenResposta,
  deps: DependenciasChat,
): Promise<void> {
  let usuarioId: string
  let conversaId: string
  let mensagem: string
  try {
    usuarioId = parseUsuario(evento)
    ;({ conversaId, mensagem } = parseCorpoChat(evento))
  } catch (erro) {
    if (erro instanceof UsuarioNaoAutenticado) {
      return endStream(open(401), `${JSON.stringify({ erro: 'não autenticado' })}\n`)
    }
    if (erro instanceof RequisicaoInvalida) {
      return endStream(open(400), `${JSON.stringify({ erro: erro.message })}\n`)
    }
    throw erro
  }

  const saida = open(200)
  const send = (dados: Record<string, unknown>) => saida.write(`${JSON.stringify(dados)}\n`)

  try {
    const conversa = await getConversa(deps.db, deps.tabelaConversas, usuarioId, conversaId)
    const mensagemUsuario: Mensagem = { role: 'user', content: [{ text: mensagem }] }

    let novas: Mensagem[] | undefined
    for await (const eventoAgente of deps.invokeAgente({
      usuario_id: usuarioId,
      conversa_id: conversaId,
      mensagens: [...(conversa?.mensagens ?? []), mensagemUsuario],
    })) {
      if (eventoAgente.tipo === 'fim') novas = eventoAgente.mensagens
      else send(eventoAgente)
    }

    if (novas && novas.length > 0) {
      await appendMensagens(deps.db, deps.tabelaConversas, {
        usuarioId,
        conversaId,
        totalAnterior: conversa?.total_mensagens ?? 0,
        titulo: conversa?.titulo ?? createTitulo(mensagem),
        novas,
      })
      send({ tipo: 'fim' })
    }
  } catch (erro) {
    logErro('stream_chat', erro)
    send({ tipo: 'erro', mensagem: erro instanceof ConversaConcorrente ? MENSAGEM_CONCORRENTE : MENSAGEM_ERRO })
  } finally {
    await endStream(saida)
  }
}

const db = createDocClient()
const agenteClient = createAgenteClient()

export const handler = awslambda.streamifyResponse(async (evento: APIGatewayProxyEvent, responseStream) => {
  const origem = process.env.ORIGEM_PERMITIDA?.trim() ?? ''
  const open: OpenResposta = (statusCode) =>
    awslambda.HttpResponseStream.from(responseStream, { statusCode, headers: createHeaders(origem) })

  let deps: DependenciasChat
  try {
    const tabelaConversas = requireEnv('TABELA_CONVERSAS')
    const agentRuntimeArn = requireEnv('AGENT_RUNTIME_ARN')
    requireEnv('ORIGEM_PERMITIDA')
    deps = {
      db,
      tabelaConversas,
      invokeAgente: (payload) => invokeAgente(agenteClient, agentRuntimeArn, payload),
    }
  } catch (erro) {
    logErro('configuracao', erro)
    return endStream(open(500), `${JSON.stringify({ erro: MENSAGEM_ERRO })}\n`)
  }

  await streamChat(evento, open, deps)
})
