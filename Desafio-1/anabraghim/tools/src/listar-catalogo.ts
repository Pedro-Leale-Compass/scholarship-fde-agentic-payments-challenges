import { ScanCommand, type ScanCommandOutput } from "@aws-sdk/lib-dynamodb"
import { ddb, tabela } from "./shared/ddb"
import { centavosParaReais } from "./shared/dinheiro"
import { criarHandler } from "./shared/handler"

interface ProdutoItem {
    produto_id: string
    nome: string
    preco_centavos: number
    moeda: string
    estoque: number
    categoria?: string
}

export interface ProdutoCatalogo {
    id: string
    nome: string
    preco: number
    moeda: string
    estoque: number
}

// Contrato da Fase 1: argumento opcional `categoria` → { produtos: [{ id, nome, preco, moeda, estoque }] }.
// Não exige usuario_id: o catálogo é público para quem está logado.
export const handler = criarHandler("listar_catalogo", async ({ argumentos }) => {
    const categoria =
        typeof argumentos.categoria === "string" && argumentos.categoria.trim() !== ""
            ? argumentos.categoria.trim()
            : undefined

    // Catálogo pequeno: Scan com filtro é suficiente. Com catálogo grande, seria
    // um GSI por categoria. O laço segue a paginação do Scan (1 MB por página).
    const itens: ProdutoItem[] = []
    let inicio: ScanCommandOutput["LastEvaluatedKey"]
    do {
        const pagina: ScanCommandOutput = await ddb.send(
            new ScanCommand({
                TableName: tabela("TABELA_PRODUTOS"),
                ...(categoria && {
                    FilterExpression: "categoria = :categoria",
                    ExpressionAttributeValues: { ":categoria": categoria },
                }),
                ExclusiveStartKey: inicio,
            })
        )
        itens.push(...((pagina.Items ?? []) as ProdutoItem[]))
        inicio = pagina.LastEvaluatedKey
    } while (inicio)

    const produtos: ProdutoCatalogo[] = itens
        .map((p) => ({
            id: p.produto_id,
            nome: p.nome,
            preco: centavosParaReais(p.preco_centavos),
            moeda: p.moeda,
            estoque: p.estoque,
        }))
        .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"))

    return { produtos }
})
