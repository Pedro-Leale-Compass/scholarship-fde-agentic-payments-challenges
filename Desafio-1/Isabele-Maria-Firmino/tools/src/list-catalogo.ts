import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createDocClient, requireEnv } from './shared/dynamo.ts'
import { parseArgumentos, parseUsuario } from './shared/contexto.ts'
import { createHandler } from './shared/resposta.ts'
import type { Produto } from './shared/produtos.ts'

export type ProdutoCatalogo = {
  id: string
  nome: string
  preco: number
  moeda: string
  estoque: number
}

export async function listCatalogo(
  db: DynamoDBDocumentClient,
  tabelaCatalogo: string,
  args: Record<string, unknown>,
): Promise<{ produtos: ProdutoCatalogo[] }> {
  const categoria = typeof args.categoria === 'string' ? args.categoria.trim().toLowerCase() : ''

  const itens: Produto[] = []
  let inicio: Record<string, unknown> | undefined
  do {
    const resultado = await db.send(new ScanCommand({ TableName: tabelaCatalogo, ExclusiveStartKey: inicio }))
    itens.push(...((resultado.Items ?? []) as Produto[]))
    inicio = resultado.LastEvaluatedKey
  } while (inicio)

  const produtos = itens
    .filter((produto) => !categoria || produto.categoria.toLowerCase() === categoria)
    .sort((a, b) => a.produto_id.localeCompare(b.produto_id))
    .map((produto) => ({
      id: produto.produto_id,
      nome: produto.nome,
      preco: produto.preco_cents / 100,
      moeda: produto.moeda,
      estoque: produto.estoque,
    }))

  return { produtos }
}

const db = createDocClient()

export const handler = createHandler('listar_catalogo', async (evento) => {
  parseUsuario(evento)
  return listCatalogo(db, requireEnv('TABELA_CATALOGO'), parseArgumentos(evento))
})
