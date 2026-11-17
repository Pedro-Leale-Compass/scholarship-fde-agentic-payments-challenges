import { CognitoJwtVerifier } from 'aws-jwt-verify'
import type { APIGatewayTokenAuthorizerHandler } from 'aws-lambda'

const userPoolId = process.env.COGNITO_USER_POOL_ID
const clientId = process.env.COGNITO_CLIENT_ID
if (!userPoolId || !clientId) throw new Error('Variáveis do Cognito não configuradas.')

const verifier = CognitoJwtVerifier.create({ userPoolId, tokenUse: 'id', clientId })

export const handler: APIGatewayTokenAuthorizerHandler = async (event) => {
  try {
    const token = event.authorizationToken?.replace(/^Bearer\s+/i, '')
    if (!token) throw new Error('missing token')
    const claims = await verifier.verify(token)
    return {
      principalId: claims.sub,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{ Action: 'execute-api:Invoke', Effect: 'Allow', Resource: event.methodArn }],
      },
      context: { sub: claims.sub },
    }
  } catch {
    throw new Error('Unauthorized')
  }
}
