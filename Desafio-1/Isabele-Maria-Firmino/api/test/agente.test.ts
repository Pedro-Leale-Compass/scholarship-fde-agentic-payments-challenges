import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore'
import {
  createRuntimeSessionId,
  invokeAgente,
  isEventoAgente,
  parseEventosSse,
  type PayloadAgente,
} from '../src/shared/agente.ts'

const USUARIO = 'usuario-teste'
const CONVERSA = '3f2a9c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f'
const ARN = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/teste'

async function* createPedacos(texto: string, tamanho: number): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(texto)
  for (let inicio = 0; inicio < bytes.length; inicio += tamanho) {
    yield bytes.slice(inicio, inicio + tamanho)
  }
}

async function collect<T>(gerador: AsyncIterable<T>): Promise<T[]> {
  const itens: T[] = []
  for await (const item of gerador) itens.push(item)
  return itens
}

function createSse(eventos: unknown[]): string {
  return eventos.map((evento) => `data: ${JSON.stringify(evento)}\n\n`).join('')
}

function createClienteFalso(resposta: { contentType?: string; response?: AsyncIterable<Uint8Array> }) {
  const enviados: Record<string, unknown>[] = []
  const cliente = {
    send: async (comando: { input: Record<string, unknown> }) => {
      enviados.push(comando.input)
      return resposta
    },
  }
  return { cliente: cliente as unknown as BedrockAgentCoreClient, enviados }
}

describe('parseEventosSse', () => {
  const eventos = [
    { tipo: 'texto', texto: 'Olá! Temos ação' },
    { tipo: 'tool', nome: 'listar_catalogo', argumentos: {}, resultado: { produtos: [] } },
    { tipo: 'fim', mensagens: [] },
  ]

  it('reconstrói eventos entregues byte a byte', async () => {
    assert.deepEqual(await collect(parseEventosSse(createPedacos(createSse(eventos), 1))), eventos)
  })

  it('preserva acentos cortados entre pedaços', async () => {
    for (const tamanho of [2, 3, 5, 7]) {
      const lidos = await collect(parseEventosSse(createPedacos(createSse([eventos[0]]), tamanho)))
      assert.deepEqual(lidos, [eventos[0]], `pedaços de ${tamanho} bytes`)
    }
  })

  it('aceita \\r\\n como quebra de linha', async () => {
    const texto = createSse(eventos).replace(/\n/g, '\r\n')
    assert.deepEqual(await collect(parseEventosSse(createPedacos(texto, 4))), eventos)
  })

  it('lê vários eventos no mesmo pedaço', async () => {
    const texto = createSse(eventos)
    assert.deepEqual(await collect(parseEventosSse(createPedacos(texto, texto.length * 4))), eventos)
  })

  it('entrega o último evento sem linha em branco final', async () => {
    const texto = `${createSse(eventos.slice(0, 2))}data: ${JSON.stringify(eventos[2])}`
    assert.deepEqual(await collect(parseEventosSse(createPedacos(texto, 6))), eventos)
  })

  it('ignora blocos sem data, como comentários', async () => {
    const texto = `: ping\n\n${createSse([eventos[0]])}: ping\n\n`
    assert.deepEqual(await collect(parseEventosSse(createPedacos(texto, 3))), [eventos[0]])
  })

  it('lança erro com JSON quebrado em vez de ignorar', async () => {
    await assert.rejects(collect(parseEventosSse(createPedacos('data: {"tipo": "texto", \n\n', 4))), SyntaxError)
  })
})

describe('isEventoAgente', () => {
  it('aceita os 4 tipos conhecidos', () => {
    for (const tipo of ['texto', 'tool', 'fim', 'erro']) assert.equal(isEventoAgente({ tipo }), true, tipo)
  })

  it('recusa tipo desconhecido, nulo, texto e objeto sem tipo', () => {
    for (const valor of [{ tipo: 'desconhecido' }, null, 'texto', {}, { tipo: 42 }]) {
      assert.equal(isEventoAgente(valor), false, JSON.stringify(valor))
    }
  })
})

describe('createRuntimeSessionId', () => {
  it('gera 64 caracteres hexadecimais', () => {
    assert.match(createRuntimeSessionId(USUARIO, CONVERSA), /^[0-9a-f]{64}$/)
  })

  it('é estável para o mesmo usuário e conversa', () => {
    assert.equal(createRuntimeSessionId(USUARIO, CONVERSA), createRuntimeSessionId(USUARIO, CONVERSA))
  })

  it('é diferente para dois usuários com o mesmo conversa_id', () => {
    assert.notEqual(createRuntimeSessionId(USUARIO, CONVERSA), createRuntimeSessionId('outro-usuario', CONVERSA))
  })

  it('é diferente para conversas diferentes do mesmo usuário', () => {
    assert.notEqual(
      createRuntimeSessionId(USUARIO, CONVERSA),
      createRuntimeSessionId(USUARIO, '9b1d2c3e-4f5a-4b6c-8d7e-0f1a2b3c4d5e'),
    )
  })
})

describe('invokeAgente', () => {
  const payload: PayloadAgente = {
    usuario_id: USUARIO,
    conversa_id: CONVERSA,
    mensagens: [{ role: 'user', content: [{ text: 'oi' }] }],
  }

  it('envia o ARN, a sessão, os headers e o payload certos', async () => {
    const { cliente, enviados } = createClienteFalso({
      contentType: 'text/event-stream',
      response: createPedacos(createSse([{ tipo: 'fim', mensagens: [] }]), 8),
    })

    await collect(invokeAgente(cliente, ARN, payload))

    assert.equal(enviados.length, 1)
    const input = enviados[0]
    assert.equal(input.agentRuntimeArn, ARN)
    assert.equal(input.runtimeSessionId, createRuntimeSessionId(USUARIO, CONVERSA))
    assert.equal(input.contentType, 'application/json')
    assert.equal(input.accept, 'text/event-stream')
    assert.deepEqual(JSON.parse(new TextDecoder().decode(input.payload as Uint8Array)), payload)
  })

  it('repassa só eventos válidos, na ordem', async () => {
    const { cliente } = createClienteFalso({
      contentType: 'text/event-stream; charset=utf-8',
      response: createPedacos(
        createSse([{ tipo: 'texto', texto: 'oi' }, { tipo: 'desconhecido' }, { tipo: 'fim', mensagens: [] }]),
        5,
      ),
    })

    assert.deepEqual(await collect(invokeAgente(cliente, ARN, payload)), [
      { tipo: 'texto', texto: 'oi' },
      { tipo: 'fim', mensagens: [] },
    ])
  })

  it('falha com mensagem clara se a resposta não for text/event-stream', async () => {
    const { cliente } = createClienteFalso({
      contentType: 'application/json',
      response: createPedacos('{"ok":true}', 4),
    })

    await assert.rejects(collect(invokeAgente(cliente, ARN, payload)), /tipo de resposta inesperado/)
  })

  it('falha se a resposta vier vazia', async () => {
    const { cliente } = createClienteFalso({ contentType: 'text/event-stream' })

    await assert.rejects(collect(invokeAgente(cliente, ARN, payload)), /resposta do agente vazia/)
  })
})
