// GET /perfil — e-mail e limite do usuário autenticado (somente leitura).
//
// Resposta: { "email": "...", "limite_total": 500, "limite_disponivel": 250.1, "moeda": "BRL" }
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda"
import { GetCommand } from "@aws-sdk/lib-dynamodb"
import { configuracao, ddb } from "./shared/ddb"
import { centavosParaReais } from "./shared/dinheiro"
import { MENSAGEM_FALHA, emailDoEvento, respostaJson, usuarioDoEvento } from "./shared/http"

// Mesmo limite que a tool realizar_compra grava na primeira compra (tools/src/shared/usuarios.ts).
// Esta Lambda não grava: só mostra o padrão enquanto o registro não existe.
export const LIMITE_PADRAO_CENTAVOS = 50_000

function centavos(valor: unknown): number {
    return typeof valor === "number" && Number.isFinite(valor) ? valor : LIMITE_PADRAO_CENTAVOS
}

export async function handler(evento: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
    const usuarioId = usuarioDoEvento(evento)
    if (!usuarioId) return respostaJson(401, { erro: "Não autenticado." })
    try {
        const { Item } = await ddb.send(
            new GetCommand({
                TableName: configuracao("TABELA_USUARIOS"),
                Key: { usuario_id: usuarioId },
                ConsistentRead: true,
            })
        )
        return respostaJson(200, {
            email: emailDoEvento(evento),
            limite_total: centavosParaReais(centavos(Item?.limite_total_centavos)),
            limite_disponivel: centavosParaReais(centavos(Item?.limite_disponivel_centavos)),
            moeda: "BRL",
        })
    } catch (error) {
        console.error("[perfil] falha ao ler o usuário", error)
        return respostaJson(500, { erro: MENSAGEM_FALHA })
    }
}
