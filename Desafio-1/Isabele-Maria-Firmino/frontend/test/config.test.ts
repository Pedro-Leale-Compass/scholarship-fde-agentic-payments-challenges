import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ConfigInvalida, parseConfig } from '../src/config.ts'

const VALIDA = {
  urlApi: 'https://abc123.execute-api.us-east-1.amazonaws.com/v1/',
  regiao: 'us-east-1',
  userPoolId: 'us-east-1_AbCdEf123',
  userPoolClientId: '1a2b3c4d5e6f7g8h9i0j',
}

describe('parseConfig', () => {
  it('aceita uma config válida', () => {
    assert.deepEqual(parseConfig(VALIDA), VALIDA)
  })

  it('acrescenta a barra final na urlApi quando ela falta', () => {
    const config = parseConfig({ ...VALIDA, urlApi: 'https://abc123.execute-api.us-east-1.amazonaws.com/v1' })
    assert.equal(config.urlApi, 'https://abc123.execute-api.us-east-1.amazonaws.com/v1/')
  })

  it('não duplica a barra final', () => {
    assert.equal(parseConfig(VALIDA).urlApi.endsWith('//'), false)
  })

  it('tira espaços das pontas dos valores', () => {
    const config = parseConfig({
      urlApi: `  ${VALIDA.urlApi}  `,
      regiao: ' us-east-1 ',
      userPoolId: ` ${VALIDA.userPoolId}\n`,
      userPoolClientId: `\t${VALIDA.userPoolClientId} `,
    })
    assert.deepEqual(config, VALIDA)
  })

  it('recusa o que não é um objeto', () => {
    for (const valor of [null, undefined, [], 'texto', 42]) {
      assert.throws(() => parseConfig(valor), ConfigInvalida, JSON.stringify(valor))
    }
  })

  it('lista quais campos faltam', () => {
    assert.throws(
      () => parseConfig({ urlApi: VALIDA.urlApi, regiao: 'us-east-1', userPoolId: '   ' }),
      (erro: unknown) =>
        erro instanceof ConfigInvalida && erro.message === 'faltam campos no config.json: userPoolId, userPoolClientId',
    )
  })

  it('recusa urlApi sem https://', () => {
    for (const urlApi of ['http://abc.execute-api.us-east-1.amazonaws.com/v1/', 'abc.execute-api.us-east-1.amazonaws.com/v1/']) {
      assert.throws(() => parseConfig({ ...VALIDA, urlApi }), /deve começar com https:\/\//, urlApi)
    }
  })

  it('recusa o config.example.json copiado sem trocar os valores', () => {
    const exemplo = JSON.parse(readFileSync(new URL('../public/config.example.json', import.meta.url), 'utf8')) as unknown
    assert.throws(
      () => parseConfig(exemplo),
      (erro: unknown) =>
        erro instanceof ConfigInvalida &&
        erro.message ===
          'o config.json ainda tem valores de exemplo: troque urlApi, userPoolId, userPoolClientId pelos valores do README',
    )
  })
})
