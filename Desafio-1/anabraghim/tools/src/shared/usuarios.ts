import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb"
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb"
import { ddb, tabela } from "./ddb"

// Mesmo padrão da Fase 1 para quem se cadastrava: R$ 500,00.
export const LIMITE_PADRAO_CENTAVOS = 50_000

export interface Usuario {
    usuario_id: string
    limite_total_centavos: number
    limite_disponivel_centavos: number
    criado_em: string
}

// Usuário convidado pelo console (sem o criar-usuario.sh) ainda não tem registro.
// O put condicional cria com o limite padrão sem sobrescrever o saldo de quem já
// existe, e é seguro se duas chamadas chegarem ao mesmo tempo.
export async function garantirUsuario(usuarioId: string): Promise<void> {
    try {
        await ddb.send(
            new PutCommand({
                TableName: tabela("TABELA_USUARIOS"),
                Item: {
                    usuario_id: usuarioId,
                    limite_total_centavos: LIMITE_PADRAO_CENTAVOS,
                    limite_disponivel_centavos: LIMITE_PADRAO_CENTAVOS,
                    criado_em: new Date().toISOString(),
                },
                ConditionExpression: "attribute_not_exists(usuario_id)",
            })
        )
    } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) throw error
    }
}

export async function buscarUsuario(usuarioId: string): Promise<Usuario | undefined> {
    const { Item } = await ddb.send(
        new GetCommand({
            TableName: tabela("TABELA_USUARIOS"),
            Key: { usuario_id: usuarioId },
            ConsistentRead: true,
        })
    )
    return Item as Usuario | undefined
}
