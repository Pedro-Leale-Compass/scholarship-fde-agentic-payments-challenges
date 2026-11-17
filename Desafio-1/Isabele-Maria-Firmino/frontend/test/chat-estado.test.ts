import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  addPergunta,
  applyErro,
  applyEvento,
  createMensagensDoHistorico,
  finishResposta,
  isEscrevendo,
  type MensagemTela,
} from '../src/chat-estado.ts'

const TOOL = { nome: 'listar_catalogo', argumentos: {}, resultado: { produtos: [] } }

function removeIds(mensagens: MensagemTela[]): Record<string, unknown>[] {
  return mensagens.map(({ id: _id, ...resto }) => resto)
}

function getResposta(mensagens: MensagemTela[]) {
  const resposta = mensagens.at(-1)
  assert.ok(resposta && resposta.tipo === 'agente', JSON.stringify(resposta))
  return resposta
}

describe('addPergunta', () => {
  it('acrescenta a pergunta e uma resposta vazia escrevendo', () => {
    assert.deepEqual(removeIds(addPergunta([], 'O que vocês têm?')), [
      { tipo: 'usuario', texto: 'O que vocês têm?' },
      { tipo: 'agente', texto: '', tools: [], escrevendo: true },
    ])
  })

  it('gera um id diferente para cada mensagem', () => {
    const mensagens = addPergunta(addPergunta([], 'primeira'), 'segunda')
    assert.equal(new Set(mensagens.map((mensagem) => mensagem.id)).size, mensagens.length)
  })
})

describe('applyEvento', () => {
  it('acumula os pedaços de texto na resposta atual', () => {
    let mensagens = addPergunta([], 'oi')
    for (const pedaco of ['Temos ', 'o Fone ', 'Bluetooth.']) {
      mensagens = applyEvento(mensagens, { tipo: 'texto', texto: pedaco })
    }
    assert.equal(getResposta(mensagens).texto, 'Temos o Fone Bluetooth.')
    assert.equal(getResposta(mensagens).escrevendo, true)
  })

  it('acrescenta a tool ao painel da resposta', () => {
    const mensagens = applyEvento(addPergunta([], 'oi'), { tipo: 'tool', ...TOOL })
    assert.deepEqual(getResposta(mensagens).tools, [TOOL])
  })

  it('encerra a resposta no fim', () => {
    let mensagens = applyEvento(addPergunta([], 'oi'), { tipo: 'texto', texto: 'Olá!' })
    mensagens = applyEvento(mensagens, { tipo: 'fim' })
    assert.equal(getResposta(mensagens).escrevendo, false)
    assert.equal(isEscrevendo(mensagens), false)
  })

  it('encerra a resposta e mostra um aviso no erro', () => {
    let mensagens = applyEvento(addPergunta([], 'oi'), { tipo: 'texto', texto: 'Um momento' })
    mensagens = applyEvento(mensagens, { tipo: 'erro', mensagem: 'Não consegui responder agora.' })
    assert.deepEqual(removeIds(mensagens).slice(1), [
      { tipo: 'agente', texto: 'Um momento', tools: [], escrevendo: false },
      { tipo: 'aviso', texto: 'Não consegui responder agora.' },
    ])
  })

  it('remove a resposta vazia quando o erro chega antes de qualquer texto', () => {
    const mensagens = applyEvento(addPergunta([], 'oi'), { tipo: 'erro', mensagem: 'Falhou.' })
    assert.deepEqual(removeIds(mensagens), [
      { tipo: 'usuario', texto: 'oi' },
      { tipo: 'aviso', texto: 'Falhou.' },
    ])
  })

  it('mantém a resposta que só tem tools ao encerrar', () => {
    let mensagens = applyEvento(addPergunta([], 'oi'), { tipo: 'tool', ...TOOL })
    mensagens = applyEvento(mensagens, { tipo: 'fim' })
    assert.equal(getResposta(mensagens).escrevendo, false)
    assert.equal(getResposta(mensagens).tools.length, 1)
  })

  it('ignora eventos que chegam depois de a resposta terminar', () => {
    const encerrada = applyEvento(applyEvento(addPergunta([], 'oi'), { tipo: 'texto', texto: 'Olá!' }), { tipo: 'fim' })
    assert.equal(applyEvento(encerrada, { tipo: 'texto', texto: ' atrasado' }), encerrada)
    assert.equal(applyEvento(encerrada, { tipo: 'tool', ...TOOL }), encerrada)
  })

  it('nunca modifica a lista recebida', () => {
    const original = addPergunta([], 'oi')
    const copia = structuredClone(original)
    const nova = applyEvento(original, { tipo: 'texto', texto: 'Olá!' })
    assert.notEqual(nova, original)
    assert.deepEqual(original, copia)
  })
})

describe('applyErro e finishResposta', () => {
  it('applyErro funciona também sem resposta em andamento', () => {
    assert.deepEqual(removeIds(applyErro([], 'Sua sessão expirou.')), [{ tipo: 'aviso', texto: 'Sua sessão expirou.' }])
  })

  it('finishResposta não muda nada quando não há resposta em andamento', () => {
    const mensagens = createMensagensDoHistorico([{ tipo: 'usuario', texto: 'oi' }])
    assert.equal(finishResposta(mensagens), mensagens)
  })
})

describe('createMensagensDoHistorico', () => {
  it('converte o histórico em mensagens com id e agente pronto', () => {
    const mensagens = createMensagensDoHistorico([
      { tipo: 'usuario', texto: 'O que vocês têm?' },
      { tipo: 'agente', texto: 'Temos o Fone Bluetooth.', tools: [TOOL] },
    ])
    assert.ok(mensagens.every((mensagem) => typeof mensagem.id === 'string' && mensagem.id.length > 0))
    assert.deepEqual(removeIds(mensagens), [
      { tipo: 'usuario', texto: 'O que vocês têm?' },
      { tipo: 'agente', texto: 'Temos o Fone Bluetooth.', tools: [TOOL], escrevendo: false },
    ])
    assert.equal(isEscrevendo(mensagens), false)
  })
})

describe('isEscrevendo', () => {
  it('fica verdadeiro enquanto há resposta em andamento', () => {
    assert.equal(isEscrevendo([]), false)
    assert.equal(isEscrevendo(addPergunta([], 'oi')), true)
  })
})
