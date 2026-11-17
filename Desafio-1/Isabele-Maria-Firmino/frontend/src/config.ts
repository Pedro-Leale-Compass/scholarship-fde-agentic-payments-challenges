import { Amplify } from 'aws-amplify'

export type ConfigApp = {
  urlApi: string
  regiao: string
  userPoolId: string
  userPoolClientId: string
}

export class ConfigInvalida extends Error {
  override name = 'ConfigInvalida'
}

const CAMPOS = ['urlApi', 'regiao', 'userPoolId', 'userPoolClientId'] as const

export function parseConfig(valor: unknown): ConfigApp {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
    throw new ConfigInvalida('o config.json precisa conter um objeto JSON')
  }

  const campos = valor as Record<string, unknown>
  const faltando = CAMPOS.filter((campo) => typeof campos[campo] !== 'string' || !String(campos[campo]).trim())
  if (faltando.length > 0) {
    throw new ConfigInvalida(`faltam campos no config.json: ${faltando.join(', ')}`)
  }

  const deExemplo = CAMPOS.filter((campo) => String(campos[campo]).includes('SUBSTITUA'))
  if (deExemplo.length > 0) {
    throw new ConfigInvalida(
      `o config.json ainda tem valores de exemplo: troque ${deExemplo.join(', ')} pelos valores do README`,
    )
  }

  const urlApi = String(campos.urlApi).trim()
  if (!urlApi.startsWith('https://')) {
    throw new ConfigInvalida('urlApi no config.json deve começar com https://')
  }

  return {
    urlApi: urlApi.endsWith('/') ? urlApi : `${urlApi}/`,
    regiao: String(campos.regiao).trim(),
    userPoolId: String(campos.userPoolId).trim(),
    userPoolClientId: String(campos.userPoolClientId).trim(),
  }
}

export async function getConfig(): Promise<ConfigApp> {
  let resposta: Response
  try {
    resposta = await fetch('/config.json', { cache: 'no-store' })
  } catch {
    throw new ConfigInvalida('não foi possível carregar o /config.json')
  }

  if (!resposta.ok) {
    throw new ConfigInvalida(
      `o /config.json não foi encontrado (HTTP ${resposta.status}). ` +
        'Crie o arquivo public/config.json a partir do public/config.example.json (veja o README).',
    )
  }

  let dados: unknown
  try {
    dados = await resposta.json()
  } catch {
    throw new ConfigInvalida('o /config.json não é um JSON válido')
  }

  return parseConfig(dados)
}

export function configureAmplify(config: ConfigApp): void {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: config.userPoolId,
        userPoolClientId: config.userPoolClientId,
        loginWith: { email: true },
      },
    },
  })
}
