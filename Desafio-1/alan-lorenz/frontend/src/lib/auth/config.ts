export type FrontendConfig = {
  userPoolId: string
  userPoolClientId: string
  chatApiUrl: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseFrontendConfig(value: unknown): FrontendConfig {
  if (!isRecord(value)) {
    throw new Error('A configuração da aplicação é inválida.')
  }

  const { userPoolId, userPoolClientId, chatApiUrl } = value
  if (
    typeof userPoolId !== 'string' ||
    !userPoolId.trim() ||
    typeof userPoolClientId !== 'string' ||
    !userPoolClientId.trim() ||
    typeof chatApiUrl !== 'string' ||
    !chatApiUrl.trim()
  ) {
    throw new Error('A configuração do Cognito ou da API está incompleta.')
  }

  let apiUrl: URL
  try {
    apiUrl = new URL(chatApiUrl)
  } catch {
    throw new Error('A URL da API de chat é inválida.')
  }
  if (
    apiUrl.protocol !== 'https:' &&
    !(apiUrl.protocol === 'http:' && apiUrl.hostname === 'localhost')
  ) {
    throw new Error('A API de chat deve usar HTTPS.')
  }

  return {
    userPoolId: userPoolId.trim(),
    userPoolClientId: userPoolClientId.trim(),
    chatApiUrl: apiUrl.toString(),
  }
}
