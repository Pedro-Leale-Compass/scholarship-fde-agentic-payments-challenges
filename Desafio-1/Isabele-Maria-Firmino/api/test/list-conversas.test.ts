import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda'
import { createAmbienteTeste, type AmbienteTeste } from './apoio.ts'
import { appendMensagens, type Mensagem } from '../src/shared/conversas.ts'
import { MENSAGEM_ERRO, formatHistorico, handleConversas, handler } from '../src/list-conversas.ts'

const USUARIO = 'usuario-teste'
const OUTRO_USUARIO = 'outro-usuario'
const ORIGEM = 'https://d123abc.cloudfront.net'
const CONVERSA_ANTIGA = '3f2a9c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f'
const CONVERSA_RECENTE = '9b1d2c3e-4f5a-4b6c-8d7e-0f1a2b3c4d5e'
const CONVERSA_ALHEIA = '0c4f6b2a-1d3e-4a5b-9c8d-7e6f5a4b3c2d'
const CATALOGO = { produtos: [{ id: 'prod_001', nome: 'Fone Bluetooth', preco: 249.9 }] }

function createTurno(pergunta: string, resposta: string, resultado = JSON.stringify(CATALOGO)): Mensagem[] {
  return [
    { role: 'user', content: [{ text: pergunta }], tracking_id: 'b7c1f0de-2a4e-4c8b-9f3a-1d2e3f4a5b6c' },
    { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'listar_catalogo', input: {} } }] },
    { role: 'user', content: [{ toolResult: { toolUseId: 't1', status: 'success', content: [{ text: resultado }] } }] },
    { role: 'assistant', content: [{ text: resposta }] },
  ]
}

function createEvento(usuario: string | undefined, id?: string): APIGatewayProxyEvent {
  return {
    requestContext: usuario === undefined ? {} : { authorizer: { claims: { sub: usuario } } },
    pathParameters: id === undefined ? null : { id },
  } as unknown as APIGatewayProxyEvent
}

function parseCorpo(resposta: APIGatewayProxyResult): Record<string, unknown> {
  return JSON.parse(resposta.body) as Record<string, unknown>
}

describe('formatHistorico', () => {
  it('um turno com tool vira um item de usuário e um item de agente com a tool', () => {
    assert.deepEqual(formatHistorico(createTurno('O que vocês têm?', 'Temos o Fone Bluetooth.')), [
      { tipo: 'usuario', texto: 'O que vocês têm?' },
      {
        tipo: 'agente',
        texto: 'Temos o Fone Bluetooth.',
        tools: [{ nome: 'listar_catalogo', argumentos: {}, resultado: CATALOGO }],
      },
    ])
  })

  it('junta o texto de antes e de depois da tool', () => {
    const mensagens: Mensagem[] = [
      { role: 'user', content: [{ text: 'Quero o fone' }] },
      {
        role: 'assistant',
        content: [
          { text: 'Vou consultar.' },
          { toolUse: { toolUseId: 't9', name: 'registrar_intencao', input: { produto_id: 'prod_001', quantidade: 1 } } },
        ],
      },
      { role: 'user', content: [{ toolResult: { toolUseId: 't9', content: [{ text: '{"status":"pendente"}' }] } }] },
      { role: 'assistant', content: [{ text: 'Pronto.' }] },
    ]

    assert.deepEqual(formatHistorico(mensagens)[1], {
      tipo: 'agente',
      texto: 'Vou consultar.\n\nPronto.',
      tools: [
        { nome: 'registrar_intencao', argumentos: { produto_id: 'prod_001', quantidade: 1 }, resultado: { status: 'pendente' } },
      ],
    })
  })

  it('mantém como texto um resultado que não é JSON', () => {
    const historico = formatHistorico(createTurno('oi', 'ok', 'resultado em texto'))
    assert.deepEqual(historico[1], {
      tipo: 'agente',
      texto: 'ok',
      tools: [{ nome: 'listar_catalogo', argumentos: {}, resultado: 'resultado em texto' }],
    })
  })

  it('dois turnos geram quatro itens alternados', () => {
    const historico = formatHistorico([...createTurno('primeira', 'um'), ...createTurno('segunda', 'dois')])
    assert.deepEqual(
      historico.map((item) => item.tipo),
      ['usuario', 'agente', 'usuario', 'agente'],
    )
  })
})

describe('list_conversas', () => {
  let ambiente: AmbienteTeste

  const handle = (evento: APIGatewayProxyEvent, tabelaConversas = ambiente.tabelaConversas) =>
    handleConversas(evento, { db: ambiente.db, tabelaConversas, origem: ORIGEM })

  const createConversa = (usuarioId: string, conversaId: string, pergunta: string, data: string) =>
    appendMensagens(
      ambiente.db,
      ambiente.tabelaConversas,
      { usuarioId, conversaId, totalAnterior: 0, titulo: pergunta, novas: createTurno(pergunta, 'Temos o Fone Bluetooth.') },
      new Date(data),
    )

  beforeEach(async () => {
    ambiente = await createAmbienteTeste()
    await createConversa(USUARIO, CONVERSA_ANTIGA, 'Conversa de ontem', '2026-11-15T10:00:00.000Z')
    await createConversa(USUARIO, CONVERSA_RECENTE, 'Conversa de hoje', '2026-11-16T10:00:00.000Z')
    await createConversa(OUTRO_USUARIO, CONVERSA_ALHEIA, 'Conversa de outra pessoa', '2026-11-16T11:00:00.000Z')
  })

  afterEach(async () => {
    delete process.env.TABELA_CONVERSAS
    delete process.env.ORIGEM_PERMITIDA
    await ambiente.deleteAmbienteTeste()
  })

  describe('GET /conversas', () => {
    it('lista só as do usuário, da mais recente para a mais antiga, sem as mensagens', async () => {
      const resposta = await handle(createEvento(USUARIO))

      assert.equal(resposta.statusCode, 200)
      assert.deepEqual(parseCorpo(resposta), {
        conversas: [
          {
            conversa_id: CONVERSA_RECENTE,
            titulo: 'Conversa de hoje',
            criada_em: '2026-11-16T10:00:00.000Z',
            atualizada_em: '2026-11-16T10:00:00.000Z',
          },
          {
            conversa_id: CONVERSA_ANTIGA,
            titulo: 'Conversa de ontem',
            criada_em: '2026-11-15T10:00:00.000Z',
            atualizada_em: '2026-11-15T10:00:00.000Z',
          },
        ],
      })
    })

    it('devolve lista vazia para quem não tem conversas', async () => {
      const resposta = await handle(createEvento('usuario-sem-conversas'))

      assert.equal(resposta.statusCode, 200)
      assert.deepEqual(parseCorpo(resposta), { conversas: [] })
    })
  })

  describe('GET /conversas/{id}', () => {
    it('devolve a conversa com o histórico convertido', async () => {
      const resposta = await handle(createEvento(USUARIO, CONVERSA_RECENTE))

      assert.equal(resposta.statusCode, 200)
      assert.deepEqual(parseCorpo(resposta), {
        conversa_id: CONVERSA_RECENTE,
        titulo: 'Conversa de hoje',
        criada_em: '2026-11-16T10:00:00.000Z',
        atualizada_em: '2026-11-16T10:00:00.000Z',
        historico: [
          { tipo: 'usuario', texto: 'Conversa de hoje' },
          {
            tipo: 'agente',
            texto: 'Temos o Fone Bluetooth.',
            tools: [{ nome: 'listar_catalogo', argumentos: {}, resultado: CATALOGO }],
          },
        ],
      })
    })

    it('responde 404 igual para conversa inexistente e para conversa de outro usuário', async () => {
      const inexistente = await handle(createEvento(USUARIO, '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'))
      const alheia = await handle(createEvento(USUARIO, CONVERSA_ALHEIA))

      assert.equal(inexistente.statusCode, 404)
      assert.equal(alheia.statusCode, 404)
      assert.deepEqual(parseCorpo(alheia), parseCorpo(inexistente))
      assert.deepEqual(parseCorpo(alheia), { erro: 'conversa não encontrada' })
    })

    it('responde 400 para id que não é UUID v4', async () => {
      const resposta = await handle(createEvento(USUARIO, 'conversa-1'))

      assert.equal(resposta.statusCode, 400)
      assert.match(String(parseCorpo(resposta).erro), /UUID/)
    })
  })

  describe('autenticação e falhas', () => {
    it('responde 401 sem sub', async () => {
      const resposta = await handle(createEvento(undefined))

      assert.equal(resposta.statusCode, 401)
      assert.deepEqual(parseCorpo(resposta), { erro: 'não autenticado' })
    })

    it('responde 500 genérico quando o banco falha, com o detalhe só no log', async (t) => {
      const log = t.mock.method(console, 'error', () => {})

      const resposta = await handle(createEvento(USUARIO), 'tabela-que-nao-existe')

      assert.equal(resposta.statusCode, 500)
      assert.deepEqual(parseCorpo(resposta), { erro: MENSAGEM_ERRO })
      assert.equal(resposta.body.includes('ResourceNotFound'), false)
      assert.equal(log.mock.callCount(), 1)
      assert.match(String(log.mock.calls[0].arguments[0]), /ResourceNotFound/)
    })

    it('todas as respostas trazem o CORS da origem configurada', async (t) => {
      t.mock.method(console, 'error', () => {})
      const respostas = [
        await handle(createEvento(USUARIO)),
        await handle(createEvento(undefined)),
        await handle(createEvento(USUARIO, CONVERSA_ALHEIA)),
        await handle(createEvento(USUARIO), 'tabela-que-nao-existe'),
      ]

      for (const resposta of respostas) {
        assert.equal(resposta.headers?.['Access-Control-Allow-Origin'], ORIGEM, String(resposta.statusCode))
        assert.equal(resposta.headers?.['Content-Type'], 'application/json; charset=utf-8')
        assert.equal(resposta.headers?.['Cache-Control'], 'no-store')
      }
    })
  })

  describe('handler', () => {
    it('responde 500 se faltar TABELA_CONVERSAS', async (t) => {
      const log = t.mock.method(console, 'error', () => {})
      process.env.ORIGEM_PERMITIDA = ORIGEM

      const resposta = await handler(createEvento(USUARIO))

      assert.equal(resposta.statusCode, 500)
      assert.deepEqual(parseCorpo(resposta), { erro: MENSAGEM_ERRO })
      assert.equal(log.mock.callCount(), 1)
    })

    it('lista pelo handler com as variáveis de ambiente', async () => {
      process.env.TABELA_CONVERSAS = ambiente.tabelaConversas
      process.env.ORIGEM_PERMITIDA = ORIGEM

      const resposta = await handler(createEvento(USUARIO))

      assert.equal(resposta.statusCode, 200)
      assert.equal((parseCorpo(resposta).conversas as unknown[]).length, 2)
    })
  })
})
