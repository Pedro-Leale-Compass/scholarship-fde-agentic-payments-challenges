import { randomUUID } from "node:crypto"
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb"
import { ddb, tabela } from "./shared/ddb"
import { centavosParaReais } from "./shared/dinheiro"
import { criarHandler, ehGuid } from "./shared/handler"
import { recusar } from "./shared/respostas"

export const INTENCAO_TTL_MINUTOS = 15
// O TTL do DynamoDB só faz a limpeza, bem depois de a intenção expirar.
const LIMPEZA_APOS_DIAS = 7

export interface IntencaoRegistrada {
    intencao_id: string
    produto_id: string
    quantidade: number
    valor_total: number
    moeda: string
    status: "pendente"
    expira_em: string
}

export const handler = criarHandler("registrar_intencao", async ({ usuarioId, argumentos }) => {
    // Ausência de identidade = chamada fora do fluxo do usuário.
    if (usuarioId == null) {
        return recusar(
            "INTENCAO_INVALIDA",
            "Não foi possível identificar o usuário da sessão. A intenção não pode ser registrada."
        )
    }

    const { produto_id, quantidade } = argumentos

    // Na Fase 1 o schema do MCP barrava isso antes do handler. Aqui a Lambda é a
    // última linha de defesa, então valida e responde no formato padrão de recusa.
    if (typeof quantidade !== "number" || !Number.isInteger(quantidade) || quantidade <= 0) {
        return recusar(
            "QUANTIDADE_INVALIDA",
            `A quantidade precisa ser um número inteiro maior que zero (recebido: ${JSON.stringify(quantidade ?? null)}).`
        )
    }

    // Valida o formato antes de ir ao banco: um id inventado pelo modelo (ex.: "prod_003")
    // vira PRODUTO_NAO_ENCONTRADO, igual a um id inexistente.
    if (!ehGuid(produto_id)) {
        return recusar(
            "PRODUTO_NAO_ENCONTRADO",
            `Não existe nenhum produto com o id "${String(produto_id ?? "")}". Consulte o catálogo e use um id retornado por listar_catalogo.`
        )
    }

    const { Item: produto } = await ddb.send(
        new GetCommand({ TableName: tabela("TABELA_PRODUTOS"), Key: { produto_id } })
    )

    if (produto == null) {
        return recusar(
            "PRODUTO_NAO_ENCONTRADO",
            `Não existe nenhum produto com o id "${produto_id}". Consulte o catálogo e use um id retornado por listar_catalogo.`
        )
    }

    if (quantidade > produto.estoque) {
        return recusar(
            "ESTOQUE_INSUFICIENTE",
            `Estoque insuficiente para "${produto.nome}": foram pedidas ${quantidade} unidades e há apenas ${produto.estoque} disponíveis.`
        )
    }

    // Valor calculado aqui, no servidor, a partir do catálogo: o preço nunca vem
    // do cliente nem do modelo. Em centavos, sem ponto flutuante.
    const valorTotalCentavos = produto.preco_centavos * quantidade
    const agora = Date.now()
    const expiraEm = new Date(agora + INTENCAO_TTL_MINUTOS * 60_000)
    const intencaoId = randomUUID()

    await ddb.send(
        new PutCommand({
            TableName: tabela("TABELA_INTENCOES"),
            Item: {
                intencao_id: intencaoId,
                // Dono da intenção vem do evento (sessão autenticada), nunca dos argumentos.
                usuario_id: usuarioId,
                produto_id,
                quantidade,
                valor_unitario_centavos: produto.preco_centavos,
                valor_total_centavos: valorTotalCentavos,
                moeda: produto.moeda,
                status: "pendente",
                expira_em: expiraEm.toISOString(),
                criado_em: new Date(agora).toISOString(),
                ttl: Math.floor(expiraEm.getTime() / 1000) + LIMPEZA_APOS_DIAS * 24 * 3600,
            },
            ConditionExpression: "attribute_not_exists(intencao_id)",
        })
    )

    const resposta: IntencaoRegistrada = {
        intencao_id: intencaoId,
        produto_id,
        quantidade,
        valor_total: centavosParaReais(valorTotalCentavos),
        moeda: produto.moeda,
        status: "pendente",
        expira_em: expiraEm.toISOString(),
    }
    return resposta
})
