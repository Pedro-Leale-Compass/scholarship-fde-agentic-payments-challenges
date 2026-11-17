import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatJson, getRotulo, getStatusTool } from '../src/components/PainelTools.tsx'
import { formatData } from '../src/components/ListaConversas.tsx'
import { getInicial } from '../src/usuario.ts'

const APROVADO = { status: 'aprovado', transacao_id: 'tx_1', valor: 249.9, limite_restante: 750.1 }
const LIMITE = { status: 'recusado', erro: 'LIMITE_EXCEDIDO', mensagem: 'O valor da compra excede o limite restante.' }
const ERRO_INTERNO = { status: 'erro', erro: 'ERRO_INTERNO', mensagem: 'Não foi possível concluir a operação agora.' }
const PENDENTE = { intencao_id: 'int_1', status: 'pendente', valor_total: 249.9 }
const CATALOGO = { produtos: [] }

describe('getStatusTool', () => {
  it('classifica aprovação, recusa e o resto', () => {
    assert.equal(getStatusTool(APROVADO), 'aprovado')
    assert.equal(getStatusTool(LIMITE), 'recusado')
    assert.equal(getStatusTool(ERRO_INTERNO), 'recusado')
    for (const resultado of [PENDENTE, CATALOGO, null, 'texto', undefined]) {
      assert.equal(getStatusTool(resultado), 'neutro', JSON.stringify(resultado))
    }
  })
})

describe('getRotulo', () => {
  it('prefere o código do erro, depois o status, e fica vazio no catálogo', () => {
    assert.equal(getRotulo(LIMITE), 'LIMITE_EXCEDIDO')
    assert.equal(getRotulo(ERRO_INTERNO), 'ERRO_INTERNO')
    assert.equal(getRotulo(APROVADO), 'aprovado')
    assert.equal(getRotulo(PENDENTE), 'pendente')
    assert.equal(getRotulo(CATALOGO), '')
    assert.equal(getRotulo(null), '')
  })
})

describe('formatJson', () => {
  it('indenta com 2 espaços', () => {
    assert.equal(formatJson({ status: 'aprovado', valor: 249.9 }), '{\n  "status": "aprovado",\n  "valor": 249.9\n}')
  })

  it('mostra null quando não há resultado', () => {
    assert.equal(formatJson(undefined), 'null')
    assert.equal(formatJson(null), 'null')
  })
})

describe('formatData', () => {
  it('formata uma data válida com dia, mês e horário', () => {
    const texto = formatData('2026-11-16T14:32:00.000Z')
    assert.match(texto, /\d{2}/)
    assert.match(texto, /nov/i)
    assert.match(texto, /\d{2}:\d{2}/)
  })

  it('devolve vazio para data inválida', () => {
    assert.equal(formatData('não é data'), '')
    assert.equal(formatData(''), '')
  })
})

describe('getInicial', () => {
  it('usa a primeira letra do e-mail em maiúscula', () => {
    assert.equal(getInicial('ana@exemplo.com'), 'A')
    assert.equal(getInicial('  bruno@exemplo.com'), 'B')
    assert.equal(getInicial('élida@exemplo.com'), 'É')
  })

  it('devolve ? sem e-mail', () => {
    assert.equal(getInicial(undefined), '?')
    assert.equal(getInicial(''), '?')
    assert.equal(getInicial('   '), '?')
  })
})
