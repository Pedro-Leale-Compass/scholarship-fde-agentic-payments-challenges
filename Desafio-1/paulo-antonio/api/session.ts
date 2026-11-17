import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

// API Gateway validates the Cognito token before invocation; never decode a token here.
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const origin = process.env.FRONTEND_ORIGIN;
  if (!origin) throw new Error('FRONTEND_ORIGIN must be configured');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
  };
  const userId: unknown = event.requestContext?.authorizer?.claims?.sub;
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    return { statusCode: 401, headers, body: JSON.stringify({ message: 'Autenticação necessária.' }) };
  }
  return {
    statusCode: 200, headers,
    body: JSON.stringify({ usuario_id: userId, autenticado: true }),
  };
}
