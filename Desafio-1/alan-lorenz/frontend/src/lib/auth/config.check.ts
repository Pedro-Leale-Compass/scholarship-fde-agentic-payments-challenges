import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseFrontendConfig } from './config.ts'

const validConfig = {
  userPoolId: 'us-east-1_pool',
  userPoolClientId: 'client-id',
  chatApiUrl: 'https://api.example.com/chat',
}

test('valida e normaliza a configuração do frontend', () => {
  assert.deepEqual(parseFrontendConfig(validConfig), validConfig)
  assert.equal(
    parseFrontendConfig({
      ...validConfig,
      chatApiUrl: 'http://localhost:3001/chat',
    }).chatApiUrl,
    'http://localhost:3001/chat',
  )
})

test('recusa configuração ausente, incompleta ou sem HTTPS', () => {
  assert.throws(() => parseFrontendConfig(null), /configuração da aplicação/)
  assert.throws(
    () => parseFrontendConfig({ ...validConfig, userPoolId: '' }),
    /incompleta/,
  )
  assert.throws(
    () => parseFrontendConfig({ ...validConfig, chatApiUrl: 'http://api.example.com/chat' }),
    /HTTPS/,
  )
})
