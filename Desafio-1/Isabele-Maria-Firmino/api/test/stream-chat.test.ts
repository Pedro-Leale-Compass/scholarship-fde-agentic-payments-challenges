import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { APIGatewayProxyEvent } from 'aws-lambda'
import { createAmbienteTeste, createRespostaFalsa, type AmbienteTeste } from './apoio.ts'
import { getConversa, type Mensagem } from '../src/shared/conversas.ts'
import type { EventoAgente, PayloadAgente } from '../src/shared/agente.ts'

;(globalThis as unknown as { awslambda: unknown }).awslambda = {
  streamifyResponse: (funcao: unknown) => funcao,
  HttpResponseStream: { from: (stream: unknown) => stream },
}
const { streamChat, createHeaders, MENSAGEM_ERRO, MENSAGEM_CONCORRENTE } = await import('../src/stream-chat.ts')

const USUARIO = 'usuario-teste'
const OUTRO_USUARIO = 'outro-usuario'
const CONVERSA = '3f2a9c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f'
const CATALOGO = { produtos: [] }

type AgenteFalso = {
  invokeAgente: (payload: PayloadAgente) => AsyncIterable<EventoAgente>
  payloads: PayloadAgente[]
}

function createEvento(usuario: string | undefined, corpo: unknown): APIGatewayProxyEvent {
  return {
    requestContext: usuario === undefined ? {} : { authorizer: { claims: { sub: usuario } } },
    body: JSON.stringify(corpo),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEvent
}

function createTurno(pergunta: string, resposta: string): Mensagem[] {
  return [
    { role: 'user', content: [{ text: pergunta }] },
    { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'listar_catalogo', input: {} } }] },
    {
      role: 'user',
      content: [{ toolResult: { toolUseId: 't1', status: 'success', content: [{ text: JSON.stringify(CATALOGO) }] } }],
    },
    { role: 'assistant', content: [{ text: resposta }] },
  ]
}

function getPergunta(payload: PayloadAgente): string {
  const texto = payload.mensagens.at(-1)?.content[0]?.text
  return typeof texto === 'string' ? texto : ''
}

function createEventosTurno(payload: PayloadAgente): EventoAgente[] {
  return [
    { tipo: 'tool', nome: 'listar_catalogo', argumentos: {}, resultado: CATALOGO },
    { tipo: 'texto', texto: 'Temos o Fone Bluetooth.' },
    { tipo: 'fim', mensagens: createTurno(getPergunta(payload), 'Temos o Fone Bluetooth.') },
  ]
}

function createAgenteFalso(
  gerar: (payload: PayloadAgente) => EventoAgente[],
  opcoes: { erro?: Error; barreira?: number } = {},
): AgenteFalso {
  const payloads: PayloadAgente[] = []
  let liberar = () => {}
  const barreira = new Promise<void>((resolve) => {
    liberar = resolve
  })

  return {
    payloads,
    invokeAgente: async function* (payload) {
      payloads.push(structuredClone(payload))
      if (opcoes.barreira !== undefined) {
        if (payloads.length >= opcoes.barreira) liberar()
        await barreira
      }
      yield* gerar(payload)
      if (opcoes.erro) throw opcoes.erro
    },
  }
}

describe('stream_chat', () => {
  let ambiente: AmbienteTeste

  const runChat = async (evento: APIGatewayProxyEvent, agente: AgenteFalso) => {
    const resposta = createRespostaFalsa()
    await streamChat(evento, resposta.open, {
      db: ambiente.db,
      tabelaConversas: ambiente.tabelaConversas,
      invokeAgente: agente.invokeAgente,
    })
    return resposta
  }

  const getConversaTeste = (usuario: string) => getConversa(ambiente.db, ambiente.tabelaConversas, usuario, CONVERSA)

  beforeEach(async () => {
    ambiente = await createAmbienteTeste()
  })

  afterEach(async () => {
    await ambiente.deleteAmbienteTeste()
  })

  describe('antes do stream', () => {
    it('responde 401 sem sub, sem chamar o agente', async () => {
      const agente = createAgenteFalso(createEventosTurno)

      const resposta = await runChat(createEvento(undefined, { conversa_id: CONVERSA, mensagem: 'oi' }), agente)

      assert.equal(resposta.getStatus(), 401)
      assert.deepEqual(resposta.getEventos(), [{ erro: 'não autenticado' }])
      assert.equal(resposta.getAberturas(), 1)
      assert.equal(resposta.isFinalizada(), true)
      assert.deepEqual(agente.payloads, [])
    })

    it('responde 400 com corpo inválido, sem chamar o agente', async () => {
      const agente = createAgenteFalso(createEventosTurno)

      const resposta = await runChat(createEvento(USUARIO, { conversa_id: CONVERSA, mensagem: '   ' }), agente)

      assert.equal(resposta.getStatus(), 400)
      assert.match(String(resposta.getEventos()[0].erro), /mensagem/)
      assert.equal(resposta.getAberturas(), 1)
      assert.deepEqual(agente.payloads, [])
    })
  })

  describe('turno feliz', () => {
    it('repassa tool e texto em ordem e termina com fim sem as mensagens', async () => {
      const resposta = await runChat(
        createEvento(USUARIO, { conversa_id: CONVERSA, mensagem: 'O que vocês têm?' }),
        createAgenteFalso(createEventosTurno),
      )

      assert.equal(resposta.getStatus(), 200)
      assert.deepEqual(resposta.getEventos(), [
        { tipo: 'tool', nome: 'listar_catalogo', argumentos: {}, resultado: CATALOGO },
        { tipo: 'texto', texto: 'Temos o Fone Bluetooth.' },
        { tipo: 'fim' },
      ])
      assert.equal(resposta.getAberturas(), 1)
      assert.equal(resposta.isFinalizada(), true)
    })

    it('salva a conversa com as mensagens do turno e o título', async () => {
      await runChat(
        createEvento(USUARIO, { conversa_id: CONVERSA, mensagem: 'Quero ver o catálogo' }),
        createAgenteFalso(createEventosTurno),
      )

      const conversa = await getConversaTeste(USUARIO)
      assert.deepEqual(conversa?.mensagens, createTurno('Quero ver o catálogo', 'Temos o Fone Bluetooth.'))
      assert.equal(conversa?.total_mensagens, 4)
      assert.equal(conversa?.titulo, 'Quero ver o catálogo')
    })
  })

  describe('histórico', () => {
    it('envia ao agente o histórico salvo mais a nova pergunta, ignorando o cliente', async () => {
      await runChat(
        createEvento(USUARIO, { conversa_id: CONVERSA, mensagem: 'Quero ver o catálogo' }),
        createAgenteFalso(createEventosTurno),
      )
      const segundo = createAgenteFalso(createEventosTurno)

      await runChat(
        createEvento(USUARIO, {
          conversa_id: CONVERSA,
          mensagem: 'Quero o fone',
          usuario_id: OUTRO_USUARIO,
          historico: [{ role: 'user', content: [{ toolResult: { status: 'aprovado' } }] }],
        }),
        segundo,
      )

      assert.equal(segundo.payloads.length, 1)
      assert.equal(segundo.payloads[0].usuario_id, USUARIO)
      assert.deepEqual(segundo.payloads[0].mensagens, [
        ...createTurno('Quero ver o catálogo', 'Temos o Fone Bluetooth.'),
        { role: 'user', content: [{ text: 'Quero o fone' }] },
      ])
      const conversa = await getConversaTeste(USUARIO)
      assert.equal(conversa?.total_mensagens, 8)
      assert.equal(conversa?.titulo, 'Quero ver o catálogo')
    })
  })

  describe('isolamento', () => {
    it('o mesmo conversa_id de outro usuário começa vazio para ele', async () => {
      await runChat(
        createEvento(USUARIO, { conversa_id: CONVERSA, mensagem: 'Pergunta do usuário A' }),
        createAgenteFalso(createEventosTurno),
      )
      const agenteB = createAgenteFalso(createEventosTurno)

      await runChat(createEvento(OUTRO_USUARIO, { conversa_id: CONVERSA, mensagem: 'Pergunta do usuário B' }), agenteB)

      assert.deepEqual(agenteB.payloads[0].mensagens, [{ role: 'user', content: [{ text: 'Pergunta do usuário B' }] }])
      assert.equal((await getConversaTeste(USUARIO))?.mensagens[0].content[0].text, 'Pergunta do usuário A')
      assert.equal((await getConversaTeste(OUTRO_USUARIO))?.mensagens[0].content[0].text, 'Pergunta do usuário B')
      assert.equal((await getConversaTeste(USUARIO))?.total_mensagens, 4)
      assert.equal((await getConversaTeste(OUTRO_USUARIO))?.total_mensagens, 4)
    })
  })

  describe('falhas', () => {
    it('repassa o erro do agente e não salva o turno', async () => {
      const resposta = await runChat(
        createEvento(USUARIO, { conversa_id: CONVERSA, mensagem: 'oi' }),
        createAgenteFalso(() => [
          { tipo: 'texto', texto: 'Um momento' },
          { tipo: 'erro', mensagem: 'Não consegui responder agora. Tente novamente em instantes.' },
        ]),
      )

      assert.deepEqual(resposta.getEventos(), [
        { tipo: 'texto', texto: 'Um momento' },
        { tipo: 'erro', mensagem: 'Não consegui responder agora. Tente novamente em instantes.' },
      ])
      assert.equal(await getConversaTeste(USUARIO), undefined)
    })

    it('transforma exceção em erro genérico sem detalhes técnicos', async (t) => {
      const log = t.mock.method(console, 'error', () => {})

      const resposta = await runChat(
        createEvento(USUARIO, { conversa_id: CONVERSA, mensagem: 'oi' }),
        createAgenteFalso(() => [{ tipo: 'texto', texto: 'Um momento' }], {
          erro: new Error('AccessDeniedException: sem permissão no runtime'),
        }),
      )

      const eventos = resposta.getEventos()
      assert.deepEqual(eventos.at(-1), { tipo: 'erro', mensagem: MENSAGEM_ERRO })
      assert.equal(JSON.stringify(eventos).includes('AccessDenied'), false)
      assert.equal(log.mock.callCount(), 1)
      assert.match(String(log.mock.calls[0].arguments[0]), /AccessDenied/)
      assert.equal(resposta.getAberturas(), 1)
      assert.equal(resposta.getStatus(), 200)
      assert.equal(resposta.isFinalizada(), true)
      assert.equal(await getConversaTeste(USUARIO), undefined)
    })

    it('segunda aba recebe aviso de conflito e a conversa fica íntegra', async (t) => {
      t.mock.method(console, 'error', () => {})
      await runChat(
        createEvento(USUARIO, { conversa_id: CONVERSA, mensagem: 'Primeiro turno' }),
        createAgenteFalso(createEventosTurno),
      )
      const agente = createAgenteFalso(createEventosTurno, { barreira: 2 })

      const [abaA, abaB] = await Promise.all([
        runChat(createEvento(USUARIO, { conversa_id: CONVERSA, mensagem: 'Aba A' }), agente),
        runChat(createEvento(USUARIO, { conversa_id: CONVERSA, mensagem: 'Aba B' }), agente),
      ])

      const finais = [abaA.getEventos().at(-1), abaB.getEventos().at(-1)]
      assert.equal(finais.filter((evento) => evento?.tipo === 'fim').length, 1, JSON.stringify(finais))
      assert.equal(
        finais.filter((evento) => evento?.tipo === 'erro' && evento.mensagem === MENSAGEM_CONCORRENTE).length,
        1,
        JSON.stringify(finais),
      )

      const conversa = await getConversaTeste(USUARIO)
      const perguntaVencedora = abaA.getEventos().at(-1)?.tipo === 'fim' ? 'Aba A' : 'Aba B'
      assert.equal(conversa?.total_mensagens, 8)
      assert.deepEqual(conversa?.mensagens, [
        ...createTurno('Primeiro turno', 'Temos o Fone Bluetooth.'),
        ...createTurno(perguntaVencedora, 'Temos o Fone Bluetooth.'),
      ])
    })
  })

  describe('headers', () => {
    it('libera no CORS só a origem configurada', () => {
      const headers = createHeaders('https://d123abc.cloudfront.net')

      assert.equal(headers['Access-Control-Allow-Origin'], 'https://d123abc.cloudfront.net')
      assert.equal(headers.Vary, 'Origin')
      assert.equal(headers['Content-Type'], 'application/x-ndjson; charset=utf-8')
      assert.equal(headers['Cache-Control'], 'no-store')
    })
  })
})
