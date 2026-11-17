import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda"

export const MENSAGEM_FALHA = "Não foi possível concluir agora por uma falha interna. Tente novamente em instantes."

// A identidade vem SEMPRE do autorizador Cognito do API Gateway, que já validou
// o JWT. Nada no corpo, na query ou nos headers da requisição é usado como identidade.
export function usuarioDoEvento(evento: APIGatewayProxyEvent): string | null {
    const sub: unknown = evento.requestContext?.authorizer?.claims?.sub
    return typeof sub === "string" && sub.trim() !== "" ? sub : null
}

export function emailDoEvento(evento: APIGatewayProxyEvent): string | null {
    const email: unknown = evento.requestContext?.authorizer?.claims?.email
    return typeof email === "string" && email !== "" ? email : null
}

export function respostaJson(statusCode: number, corpo: unknown): APIGatewayProxyResult {
    return {
        statusCode,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        body: JSON.stringify(corpo),
    }
}
