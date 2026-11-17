import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env'
import { NewPasswordRequiredError, authService } from './authService'

function createJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `${header}.${body}.signature`
}

const fetchMock = vi.fn()
const originalClientId = env.cognitoClientId

beforeEach(() => {
  env.cognitoClientId = 'test-client-id'
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('window', new EventTarget())
})

afterEach(() => {
  env.cognitoClientId = originalClientId
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

describe('Cognito authService - fluxo NEW_PASSWORD_REQUIRED', () => {
  it('lança NewPasswordRequiredError com username resolvido e sessão quando Cognito exige troca de senha', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ChallengeName: 'NEW_PASSWORD_REQUIRED',
          Session: 'session-token-abc',
          ChallengeParameters: {
            USER_ID_FOR_SRP: 'pedro.leale',
          },
        }),
        { status: 200 },
      ),
    )

    let caught: unknown = null
    try {
      await authService.login({ username: 'pedro.leale@compasso.com.br', password: 'TempPassword1' })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(NewPasswordRequiredError)
    expect(caught).toMatchObject({
      username: 'pedro.leale',
      session: 'session-token-abc',
    })
  })

  it('envia RespondToAuthChallenge e retorna sessão autenticada com IdToken', async () => {
    const idToken = createJwt({
      sub: 'user-sub-123',
      'cognito:username': 'pedro.leale',
      name: 'Pedro Leale',
    })

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          AuthenticationResult: {
            IdToken: idToken,
            ExpiresIn: 3600,
          },
        }),
        { status: 200 },
      ),
    )

    const result = await authService.completeNewPassword({
      username: 'pedro.leale',
      newPassword: 'NovaSenha123',
      session: 'session-token-abc',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://cognito-idp.us-east-1.amazonaws.com/',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Amz-Target': 'AWSCognitoIdentityProviderService.RespondToAuthChallenge',
        }),
        body: JSON.stringify({
          ChallengeName: 'NEW_PASSWORD_REQUIRED',
          ClientId: 'test-client-id',
          Session: 'session-token-abc',
          ChallengeResponses: {
            USERNAME: 'pedro.leale',
            NEW_PASSWORD: 'NovaSenha123',
          },
        }),
      }),
    )

    expect(result).toEqual({
      token: idToken,
      expiresIn: '3600s',
      user: {
        id: 'user-sub-123',
        username: 'pedro.leale',
        name: 'Pedro Leale',
        limite_total: 0,
        limite_disponivel: 0,
      },
    })
  })

  it('traduz InvalidPasswordException do Cognito para mensagem da política de senha', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          __type: 'InvalidPasswordException',
          message: 'Password does not conform to policy',
        }),
        { status: 400 },
      ),
    )

    await expect(
      authService.completeNewPassword({
        username: 'pedro.leale',
        newPassword: '123',
        session: 'session-token-abc',
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'A nova senha deve ter no mínimo 8 caracteres, incluindo letra minúscula e número.',
    })
  })
})
