import { Writable } from "node:stream"
import { mockClient } from "aws-sdk-client-mock"
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb"
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore"
import { afterEach, beforeEach } from "vitest"

// Nenhum teste fala com a AWS: os clientes são substituídos por mocks e qualquer
// comando sem resposta configurada devolve undefined.
export const ddbMock = mockClient(DynamoDBDocumentClient)
export const agentcoreMock = mockClient(BedrockAgentCoreClient)

process.env.AWS_REGION = "us-east-1"
process.env.AWS_ACCESS_KEY_ID = "teste"
process.env.AWS_SECRET_ACCESS_KEY = "teste"
process.env.TABELA_CONVERSAS = "t-conversas"
process.env.TABELA_USUARIOS = "t-usuarios"
process.env.AGENTE_RUNTIME_ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/ana_braghim_agente-AbCdEf1234"

// O runtime Node da Lambda define o global `awslambda`. Aqui ele é simulado:
// streamifyResponse devolve o próprio handler e HttpResponseStream.from guarda o
// status e os headers no stream de teste.
export class StreamDeTeste extends Writable {
    pedacos: string[] = []
    metadata: Record<string, unknown> | null = null
    finalizado = false

    override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
        this.pedacos.push(chunk.toString("utf-8"))
        callback()
    }

    override _final(callback: () => void): void {
        this.finalizado = true
        callback()
    }

    get texto(): string {
        return this.pedacos.join("")
    }

    get eventos(): Record<string, unknown>[] {
        return this.texto
            .split("\n")
            .filter((linha) => linha !== "")
            .map((linha) => JSON.parse(linha))
    }
}

;(globalThis as Record<string, unknown>).awslambda = {
    streamifyResponse: <T>(handler: T) => handler,
    HttpResponseStream: {
        from(stream: StreamDeTeste, metadata: Record<string, unknown>) {
            stream.metadata = metadata
            return stream
        },
    },
}

beforeEach(() => {
    ddbMock.reset()
    agentcoreMock.reset()
})

afterEach(() => {
    ddbMock.reset()
    agentcoreMock.reset()
})

export const USUARIO = "aaaaaaaa-0000-0000-0000-000000000001"
export const OUTRO_USUARIO = "bbbbbbbb-0000-0000-0000-000000000002"

// Evento REST do API Gateway depois do autorizador Cognito.
export function eventoApi(opcoes: { sub?: string | null; email?: string; body?: string | null; base64?: boolean } = {}) {
    const sub = opcoes.sub === undefined ? USUARIO : opcoes.sub
    const claims: Record<string, string> = {}
    if (sub !== null) claims.sub = sub
    if (opcoes.email) claims.email = opcoes.email
    return {
        body: opcoes.body ?? null,
        isBase64Encoded: opcoes.base64 ?? false,
        headers: {},
        requestContext: { authorizer: { claims } },
    } as never
}
