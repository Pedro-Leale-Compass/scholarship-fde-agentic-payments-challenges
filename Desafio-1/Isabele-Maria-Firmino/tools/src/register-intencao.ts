import { randomBytes } from 'node:crypto'
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { CONDITIONAL_CHECK_FAILED, createDocClient, getNomeErro, requireEnv } from './shared/dynamo.ts'
import { parseArgumentos, parseConversa, parseUsuario } from './shared/contexto.ts'
import { createHandler, createRecusa, type Recusa } from './shared/resposta.ts'
import type { Produto } from './shared/produtos.ts'

export const VALIDADE_INTENCAO_MINUTOS = 5
const MAXIMO_TENTATIVAS_ID = 3

export type Intencao = {
  intencao_id: string
  usuario_id: string
  conversa_id: string
  produto_id: string
  quantidade: number
  valor_total_cents: number
  moeda: string
  status: 'pendente' | 'paga' | 'cancelada_estoque'
  criada_em: string
  expira_em: string
}

export type RecusaIntencao = Recusa<'PRODUTO_INEXISTENTE' | 'QUANTIDADE_INVALIDA' | 'ESTOQUE_INSUFICIENTE'>

export type IntencaoRegistrada = {
  intencao_id: string
  produto_id: string
  quantidade: number
  valor_total: number
  moeda: string
  status: 'pendente'
  expira_em: string
  valido_por_minutos: number
}

export function createIntencaoId(): string {
  return `int_${randomBytes(6).toString('hex')}`
}

export async function registerIntencao(
  db: DynamoDBDocumentClient,
  tabelas: { catalogo: string; intencoes: string },
  usuarioId: string,
  conversaId: string,
  args: Record<string, unknown>,
  agora = new Date(),
): Promise<IntencaoRegistrada | RecusaIntencao> {
  const produtoId = typeof args.produto_id === 'string' ? args.produto_id.trim() : ''
  if (!produtoId) return createRecusa('PRODUTO_INEXISTENTE', 'Produto não encontrado no catálogo.')

  const quantidade = args.quantidade
  if (typeof quantidade !== 'number' || !Number.isSafeInteger(quantidade) || quantidade <= 0) {
    return createRecusa('QUANTIDADE_INVALIDA', 'Quantidade deve ser um inteiro maior que zero.')
  }

  const { Item } = await db.send(new GetCommand({ TableName: tabelas.catalogo, Key: { produto_id: produtoId } }))
  const produto = Item as Produto | undefined
  if (!produto) return createRecusa('PRODUTO_INEXISTENTE', 'Produto não encontrado no catálogo.')
  if (quantidade > produto.estoque) {
    return createRecusa('ESTOQUE_INSUFICIENTE', 'Estoque insuficiente para a quantidade solicitada.')
  }

  const criadaEm = agora.toISOString()
  const expiraEm = new Date(agora.getTime() + VALIDADE_INTENCAO_MINUTOS * 60_000).toISOString()

  for (let tentativa = 1; ; tentativa++) {
    const intencao: Intencao = {
      intencao_id: createIntencaoId(),
      usuario_id: usuarioId,
      conversa_id: conversaId,
      produto_id: produto.produto_id,
      quantidade,
      valor_total_cents: produto.preco_cents * quantidade,
      moeda: produto.moeda,
      status: 'pendente',
      criada_em: criadaEm,
      expira_em: expiraEm,
    }

    try {
      await db.send(
        new PutCommand({
          TableName: tabelas.intencoes,
          Item: intencao,
          ConditionExpression: 'attribute_not_exists(intencao_id)',
        }),
      )
    } catch (erro) {
      if (getNomeErro(erro) === CONDITIONAL_CHECK_FAILED && tentativa < MAXIMO_TENTATIVAS_ID) continue
      throw erro
    }

    return {
      intencao_id: intencao.intencao_id,
      produto_id: intencao.produto_id,
      quantidade: intencao.quantidade,
      valor_total: intencao.valor_total_cents / 100,
      moeda: intencao.moeda,
      status: 'pendente',
      expira_em: intencao.expira_em,
      valido_por_minutos: VALIDADE_INTENCAO_MINUTOS,
    }
  }
}

const db = createDocClient()

export const handler = createHandler('registrar_intencao', async (evento) =>
  registerIntencao(
    db,
    { catalogo: requireEnv('TABELA_CATALOGO'), intencoes: requireEnv('TABELA_INTENCOES') },
    parseUsuario(evento),
    parseConversa(evento),
    parseArgumentos(evento),
  ),
)
