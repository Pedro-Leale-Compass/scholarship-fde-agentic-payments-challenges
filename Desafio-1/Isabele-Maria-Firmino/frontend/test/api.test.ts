import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MENSAGEM_MUITAS_REQUISICOES,
  MENSAGEM_NAO_ENCONTRADA,
  MENSAGEM_PADRAO,
  MENSAGEM_SEM_CONEXAO,
  MENSAGEM_SESSAO_EXPIRADA,
  getMensagemStatus,
  isEventoChat,
  parseNdjson,
} from '../src/api.ts'

const EVENTOS = [
  { tipo: 'texto', texto: 'Olá! Temos ação' },
  { tipo: 'tool', nome: 'listar_catalogo', argumentos: {}, resultado: { produtos: [] } },
  { tipo: 'fim' },
]

function createNdjson(eventos: unknown[]): string {
  return eventos.map((evento) => `${JSON.stringify(evento)}\n`).join('')
}

describe('parseNdjson', () => {
  it('lê linhas completas e deixa o resto vazio', () => {
    assert.deepEqual(parseNdjson(createNdjson(EVENTOS)), { linhas: EVENTOS, resto: '' })
  })

  it('guarda a linha cortada no resto até ela se completar', () => {
    const texto = createNdjson(EVENTOS)
    const corte = texto.indexOf('listar_catalogo')

    const primeiro = parseNdjson(texto.slice(0, corte))
    assert.deepEqual(primeiro.linhas, [EVENTOS[0]])
    assert.ok(primeiro.resto.startsWith('{"tipo":"tool"'))

    const segundo = parseNdjson(primeiro.resto + texto.slice(corte))
    assert.deepEqual(segundo.linhas, EVENTOS.slice(1))
    assert.equal(segundo.resto, '')
  })

  it('ignora linhas vazias', () => {
    assert.deepEqual(parseNdjson(`\n\n${createNdjson([EVENTOS[2]])}\n`).linhas, [EVENTOS[2]])
  })

  it('reconstrói um stream inteiro entregue em pedaços pequenos', () => {
    const texto = createNdjson(EVENTOS)
    const lidos: unknown[] = []
    let resto = ''
    for (let inicio = 0; inicio < texto.length; inicio += 3) {
      const resultado = parseNdjson(resto + texto.slice(inicio, inicio + 3))
      lidos.push(...resultado.linhas)
      resto = resultado.resto
    }
    lidos.push(...parseNdjson(`${resto}\n`).linhas)
    assert.deepEqual(lidos, EVENTOS)
  })

  it('lança erro com JSON quebrado em vez de ignorar', () => {
    assert.throws(() => parseNdjson('{"tipo": "texto", \n'), SyntaxError)
  })
})

describe('isEventoChat', () => {
  it('aceita os 4 tipos de evento', () => {
    for (const tipo of ['texto', 'tool', 'erro', 'fim']) assert.equal(isEventoChat({ tipo }), true, tipo)
  })

  it('recusa tipo desconhecido, nulo, texto e objeto sem tipo', () => {
    for (const valor of [{ tipo: 'desconhecido' }, null, 'texto', {}, { tipo: 1 }]) {
      assert.equal(isEventoChat(valor), false, JSON.stringify(valor))
    }
  })
})

describe('getMensagemStatus', () => {
  it('traduz cada status para uma mensagem ao usuário', () => {
    assert.equal(getMensagemStatus(0), MENSAGEM_SEM_CONEXAO)
    assert.equal(getMensagemStatus(401), MENSAGEM_SESSAO_EXPIRADA)
    assert.equal(getMensagemStatus(403), MENSAGEM_SESSAO_EXPIRADA)
    assert.equal(getMensagemStatus(404), MENSAGEM_NAO_ENCONTRADA)
    assert.equal(getMensagemStatus(429), MENSAGEM_MUITAS_REQUISICOES)
    assert.equal(getMensagemStatus(500), MENSAGEM_PADRAO)
  })

  it('usa a mensagem do servidor no 400 e a padrão quando ela falta', () => {
    assert.equal(getMensagemStatus(400, 'mensagem deve ter entre 1 e 2000 caracteres'), 'mensagem deve ter entre 1 e 2000 caracteres')
    assert.equal(getMensagemStatus(400), MENSAGEM_PADRAO)
  })

  it('não repassa a mensagem do servidor em outros status', () => {
    assert.equal(getMensagemStatus(500, 'detalhe interno'), MENSAGEM_PADRAO)
  })
})
