import { env } from '../config/env'
import { demoProfiles } from '../config/demoProfiles'
import { AUTH_EXPIRED_EVENT, ApiError, OFFLINE_MESSAGE } from '../types/api'
import type {
  CompleteNewPasswordRequest,
  LoginRequest,
  LoginResponse,
  UserProfile,
} from '../types/auth'
import { apiRequest, requestSignal } from './apiClient'
import { isLogin, isRecord, isUser } from '../utils/guards'

const USER_STORAGE_KEY = 'nexus_auth_user'

/** Erro sinalizado pelo Cognito quando o usuário entra com senha temporária no primeiro acesso. */
export class NewPasswordRequiredError extends ApiError {
  readonly username: string
  readonly session: string

  constructor(username: string, session: string) {
    super('Defina uma nova senha definitiva para concluir seu primeiro acesso.', 200)
    this.name = 'NewPasswordRequiredError'
    this.username = username
    this.session = session
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.')
  if (parts.length < 2) throw new ApiError('Token JWT inválido recebido do Cognito.', 401)
  const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (!isRecord(parsed)) throw new ApiError('Payload JWT inválido.', 401)
  return parsed
}

function readStoredUser(): UserProfile | null {
  try {
    const raw = localStorage.getItem(USER_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isUser(parsed) ? parsed : null
  } catch {
    return null
  }
}

function buildProfileFromClaims(
  claims: Record<string, unknown>,
  fallbackUsername?: string,
  preferStoredBalance = true,
): UserProfile {
  const sub = typeof claims.sub === 'string' ? claims.sub : ''
  const username =
    typeof claims['cognito:username'] === 'string' && claims['cognito:username']
      ? claims['cognito:username']
      : fallbackUsername || sub
  const demo = demoProfiles.find((profile) => profile.username === username)
  const stored = preferStoredBalance ? readStoredUser() : null
  const matchingStored = stored && stored.id === sub ? stored : null

  const defaultLimit = demo?.limit ?? 0
  const name =
    (typeof claims.name === 'string' && claims.name.trim()) ||
    matchingStored?.name ||
    demo?.name ||
    username

  return {
    id: sub,
    username,
    name,
    limite_total: matchingStored ? matchingStored.limite_total : defaultLimit,
    limite_disponivel: matchingStored ? matchingStored.limite_disponivel : defaultLimit,
  }
}

function mapCognitoError(errorBody: unknown): string {
  if (!isRecord(errorBody)) return 'Não foi possível autenticar no Cognito.'
  const errorType = typeof errorBody.__type === 'string' ? errorBody.__type : ''
  if (errorType.includes('NotAuthorizedException') || errorType.includes('UserNotFoundException')) {
    return 'Usuário ou senha inválidos.'
  }
  if (errorType.includes('InvalidPasswordException')) {
    return 'A nova senha deve ter no mínimo 8 caracteres, incluindo letra minúscula e número.'
  }
  if (
    errorType.includes('PasswordResetRequiredException') ||
    errorType.includes('UserNotConfirmedException')
  ) {
    return 'Sua conta precisa concluir a ativação no Cognito.'
  }
  return typeof errorBody.message === 'string' && errorBody.message
    ? errorBody.message
    : 'Não foi possível autenticar no Cognito.'
}

async function callCognito(
  target: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(`https://cognito-idp.${env.cognitoRegion}.amazonaws.com/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': target,
      },
      body: JSON.stringify(body),
      signal: requestSignal(undefined, 15000),
    })
  } catch (cause) {
    if (cause instanceof ApiError) throw cause
    throw new ApiError(OFFLINE_MESSAGE)
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw new ApiError(mapCognitoError(payload), response.status)
  }

  if (!isRecord(payload)) {
    throw new ApiError('Resposta inválida do Amazon Cognito.')
  }

  return payload
}

function parseAuthSuccess(
  payload: Record<string, unknown>,
  fallbackUsername: string,
): LoginResponse {
  const authResult = isRecord(payload.AuthenticationResult) ? payload.AuthenticationResult : null
  const idToken = authResult && typeof authResult.IdToken === 'string' ? authResult.IdToken : ''
  if (!idToken) {
    throw new ApiError('Token de identidade não retornado pelo Cognito.', 401)
  }

  const claims = decodeJwtPayload(idToken)
  const user = buildProfileFromClaims(claims, fallbackUsername, false)
  const expiresInSeconds =
    authResult && typeof authResult.ExpiresIn === 'number' ? authResult.ExpiresIn : 3600

  return {
    token: idToken,
    user,
    expiresIn: `${expiresInSeconds}s`,
  }
}

export function syncUserBalance(newBalance: number, newName?: string): void {
  if (!Number.isFinite(newBalance)) return
  const current = readStoredUser()
  if (!current) return
  const nextTotal = Math.max(current.limite_total, newBalance)
  const nextName = newName && newName.trim() ? newName.trim() : current.name
  try {
    localStorage.setItem(
      USER_STORAGE_KEY,
      JSON.stringify({
        ...current,
        name: nextName,
        limite_total: nextTotal,
        limite_disponivel: newBalance,
      }),
    )
  } catch {
    /* Estado em memória seguirá válido na próxima consulta. */
  }
}

export const authService = {
  async login(credentials: LoginRequest): Promise<LoginResponse> {
    if (!env.cognitoClientId) {
      return apiRequest('/api/auth/login', {
        method: 'POST',
        body: credentials,
        validate: isLogin,
      })
    }

    const payload = await callCognito('AWSCognitoIdentityProviderService.InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: env.cognitoClientId,
      AuthParameters: {
        USERNAME: credentials.username,
        PASSWORD: credentials.password,
      },
    })

    if (typeof payload.ChallengeName === 'string' && payload.ChallengeName) {
      if (payload.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
        const session = typeof payload.Session === 'string' ? payload.Session : ''
        if (!session) {
          throw new ApiError('Sessão de troca de senha não retornada pelo Cognito.', 400)
        }
        const challengeParams = isRecord(payload.ChallengeParameters)
          ? payload.ChallengeParameters
          : null
        const challengeUsername =
          challengeParams &&
          typeof challengeParams.USER_ID_FOR_SRP === 'string' &&
          challengeParams.USER_ID_FOR_SRP
            ? challengeParams.USER_ID_FOR_SRP
            : credentials.username
        throw new NewPasswordRequiredError(challengeUsername, session)
      }
      throw new ApiError(`Desafio de autenticação não suportado: ${payload.ChallengeName}`, 400)
    }

    return parseAuthSuccess(payload, credentials.username)
  },

  async completeNewPassword(request: CompleteNewPasswordRequest): Promise<LoginResponse> {
    const payload = await callCognito('AWSCognitoIdentityProviderService.RespondToAuthChallenge', {
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      ClientId: env.cognitoClientId,
      Session: request.session,
      ChallengeResponses: {
        USERNAME: request.username,
        NEW_PASSWORD: request.newPassword,
      },
    })

    if (typeof payload.ChallengeName === 'string' && payload.ChallengeName) {
      throw new ApiError(`Desafio adicional não suportado: ${payload.ChallengeName}`, 400)
    }

    return parseAuthSuccess(payload, request.username)
  },

  async me(token: string, signal?: AbortSignal): Promise<UserProfile> {
    if (!env.cognitoClientId) {
      return apiRequest('/api/user/me', { token, signal, validate: isUser })
    }

    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    try {
      const claims = decodeJwtPayload(token)
      const isExpired = typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()
      if (isExpired) {
        window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
        throw new ApiError('Sua sessão expirou. Entre novamente.', 401)
      }
      return buildProfileFromClaims(claims)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
      }
      throw cause
    }
  },
}
