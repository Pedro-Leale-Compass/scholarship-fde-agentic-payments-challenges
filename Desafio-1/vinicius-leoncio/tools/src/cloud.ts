import { randomBytes } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'

export type PaymentContext = { userId: string; conversationId: string }
export type ToolEvent<T> = { context: PaymentContext; arguments: T }
type ProductBase = { id: string; nome: string; preco: number; moeda: string; categoria: string }
type Product = ProductBase & { PK: string; SK: string; entity: 'Product'; estoque: number }
type Profile = { PK: string; SK: 'PROFILE'; userId: string; availableLimit: number; createdAt: string }
type Intent = {
  PK: string; SK: string; entity: 'Intent'; userId: string; conversationId: string
  intencaoId: string; produtoId: string; quantidade: number; valorTotal: number; moeda: string
  status: 'pendente' | 'paga'; expiraEm: string; expiresAt: number
}
type Method = 'cartao' | 'pix'

const products: ProductBase[] = [
  { id: 'prod_001', nome: 'PlayStation 5', preco: 4799, moeda: 'BRL', categoria: 'games' },
  { id: 'prod_002', nome: 'PC Gamer', preco: 12499, moeda: 'BRL', categoria: 'informatica' },
  { id: 'prod_003', nome: 'Fone Bluetooth', preco: 249.9, moeda: 'BRL', categoria: 'audio' },
  { id: 'prod_004', nome: 'Monitor Gamer 27" 144Hz', preco: 1899.9, moeda: 'BRL', categoria: 'monitores' },
  { id: 'prod_005', nome: 'Cadeira Gamer Ergonômica', preco: 1299, moeda: 'BRL', categoria: 'moveis' },
  { id: 'prod_006', nome: 'Mouse Sem Fio', preco: 149.5, moeda: 'BRL', categoria: 'perifericos' },
  { id: 'prod_007', nome: 'Teclado Mecânico RGB', preco: 299.9, moeda: 'BRL', categoria: 'perifericos' },
]
const stocks: Record<string, number> = { prod_001: 10, prod_002: 5, prod_003: 12, prod_004: 8, prod_005: 15, prod_006: 25, prod_007: 18 }
const tableName = process.env.PAYMENTS_TABLE_NAME
if (!tableName) throw new Error('PAYMENTS_TABLE_NAME não foi configurada.')
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } })

const key = (userId: string, sortKey: string) => ({ PK: 'USER#' + userId, SK: sortKey })
const roundMoney = (n: number) => Number(n.toFixed(2))
const newId = (prefix: string) => prefix + '_' + randomBytes(6).toString('hex')
const normalize = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
const isConditional = (e: unknown) => e instanceof Error && e.name === 'ConditionalCheckFailedException'

function contextOf(context: PaymentContext) {
  if (!context?.userId?.trim() || !context?.conversationId?.trim()) throw new Error('Faltam claims de usuário ou conversa confiáveis.')
  return context
}
function refuse(erro: 'INTENCAO_INVALIDA' | 'INTENCAO_EXPIRADA' | 'INTENCAO_JA_PAGA' | 'LIMITE_EXCEDIDO' | 'METODO_INVALIDO', mensagem: string) {
  return { status: 'recusado' as const, erro, mensagem }
}

let seed: Promise<void> | undefined
async function seedCatalog() {
  seed ??= Promise.all(products.map(async (p) => {
    try {
      await db.send(new PutCommand({
        TableName: tableName,
        Item: { ...p, PK: 'CATALOG', SK: 'PRODUCT#' + p.id, entity: 'Product', estoque: stocks[p.id] },
        ConditionExpression: 'attribute_not_exists(PK)',
      }))
    } catch (error) { if (!isConditional(error)) throw error }
  })).then(() => undefined)
  await seed
}
async function getProduct(id: string) {
  const out = await db.send(new GetCommand({ TableName: tableName, Key: { PK: 'CATALOG', SK: 'PRODUCT#' + id }, ConsistentRead: true }))
  return out.Item as Product | undefined
}
async function getProfile(userId: string) {
  const out = await db.send(new GetCommand({ TableName: tableName, Key: key(userId, 'PROFILE'), ConsistentRead: true }))
  return out.Item as Profile | undefined
}
async function ensureProfile(userId: string): Promise<Profile> {
  const existing = await getProfile(userId)
  if (existing) return existing
  const limit = Number(process.env.DEFAULT_USER_LIMIT ?? 500)
  if (!Number.isFinite(limit) || limit < 0) throw new Error('DEFAULT_USER_LIMIT deve ser um número maior ou igual a zero.')
  const profile: Profile = { ...key(userId, 'PROFILE'), SK: 'PROFILE', userId, availableLimit: roundMoney(limit), createdAt: new Date().toISOString() }
  try {
    await db.send(new PutCommand({ TableName: tableName, Item: profile, ConditionExpression: 'attribute_not_exists(PK)' }))
    return profile
  } catch (error) {
    if (!isConditional(error)) throw error
    const winner = await getProfile(userId)
    if (!winner) throw error
    return winner
  }
}
async function getIntent(userId: string, intentId: string) {
  const out = await db.send(new GetCommand({ TableName: tableName, Key: key(userId, 'INTENT#' + intentId), ConsistentRead: true }))
  return out.Item as Intent | undefined
}
async function audit(context: PaymentContext, tool: string, parameters: Record<string, unknown>, result: unknown) {
  const timestamp = new Date().toISOString()
  try {
    await db.send(new PutCommand({
      TableName: tableName,
      Item: { ...key(context.userId, 'AUDIT#' + timestamp + '#' + newId('log')), entity: 'Audit', userId: context.userId, conversationId: context.conversationId, tool, parameters, result, timestamp },
    }))
  } catch (error) { console.error('Falha ao persistir auditoria da ferramenta.', error) }
}

export async function listarCatalogo(event: ToolEvent<{ categoria?: string }>) {
  const context = contextOf(event.context)
  await seedCatalog()
  const out = await db.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': 'CATALOG', ':prefix': 'PRODUCT#' },
  }))
  const category = typeof event.arguments?.categoria === 'string' ? normalize(event.arguments.categoria) : ''
  const list = ((out.Items ?? []) as Product[]).filter((p) => !category || normalize(p.categoria) === category)
  const response = { produtos: list.map(({ id, nome, preco, moeda, estoque }) => ({ id, nome, preco, moeda, estoque })) }
  await audit(context, 'listar_catalogo', { categoria: event.arguments?.categoria }, { total: response.produtos.length })
  return response
}

export async function registrarIntencao(event: ToolEvent<{ produto_id: string; quantidade: number }>) {
  const context = contextOf(event.context)
  const args = event.arguments
  if (!args || typeof args.produto_id !== 'string' || !args.produto_id) {
    return { status: 'recusado' as const, erro: 'PRODUTO_INVALIDO', mensagem: 'Produto não encontrado no catálogo.' }
  }
  if (!Number.isInteger(args.quantidade) || args.quantidade <= 0) {
    return { status: 'recusado' as const, erro: 'QUANTIDADE_INVALIDA', mensagem: 'A quantidade deve ser um inteiro maior que zero.' }
  }
  await seedCatalog()
  const product = await getProduct(args.produto_id)
  if (!product) return { status: 'recusado' as const, erro: 'PRODUTO_INVALIDO', mensagem: 'Produto não encontrado no catálogo.' }
  if (args.quantidade > product.estoque) {
    return { status: 'recusado' as const, erro: 'ESTOQUE_INSUFICIENTE', mensagem: 'Não há estoque suficiente para essa quantidade.' }
  }
  await ensureProfile(context.userId)
  const now = new Date()
  const expiresAt = Math.floor(now.getTime() / 1000) + 600
  const intentId = newId('int')
  const total = roundMoney(product.preco * args.quantidade)
  const intent: Intent = {
    ...key(context.userId, 'INTENT#' + intentId), entity: 'Intent', userId: context.userId,
    conversationId: context.conversationId, intencaoId: intentId, produtoId: product.id,
    quantidade: args.quantidade, valorTotal: total, moeda: product.moeda, status: 'pendente',
    expiraEm: new Date(expiresAt * 1000).toISOString(), expiresAt,
  }
  await db.send(new PutCommand({ TableName: tableName, Item: intent, ConditionExpression: 'attribute_not_exists(PK)' }))
  const response = { intencao_id: intentId, produto_id: product.id, quantidade: args.quantidade, valor_total: total, moeda: product.moeda, status: 'pendente' as const, expira_em: intent.expiraEm }
  await audit(context, 'registrar_intencao', args, response)
  return response
}

export async function realizarCompra(event: ToolEvent<{ intencao_id: string; metodo_pagamento: string }>) {
  const context = contextOf(event.context)
  const args = event.arguments
  const intentId = typeof args?.intencao_id === 'string' ? args.intencao_id : ''
  const intent = intentId ? await getIntent(context.userId, intentId) : undefined
  if (!intent || intent.userId !== context.userId || intent.conversationId !== context.conversationId) {
    return refuse('INTENCAO_INVALIDA', 'A intenção informada não é válida para esta conversa.')
  }
  if (intent.status === 'paga') return refuse('INTENCAO_JA_PAGA', 'Esta intenção já foi utilizada em uma compra.')
  const now = new Date()
  if (now.getTime() >= intent.expiresAt * 1000) return refuse('INTENCAO_EXPIRADA', 'Esta intenção de compra expirou.')
  if (args.metodo_pagamento !== 'cartao' && args.metodo_pagamento !== 'pix') {
    return refuse('METODO_INVALIDO', 'Use cartao ou pix como método de pagamento.')
  }
  const profile = await ensureProfile(context.userId)
  if (intent.valorTotal > profile.availableLimit) return refuse('LIMITE_EXCEDIDO', 'O valor da compra excede o limite disponível do usuário.')
  await seedCatalog()
  const product = await getProduct(intent.produtoId)
  if (!product || product.estoque < intent.quantidade) {
    return refuse('INTENCAO_INVALIDA', 'O produto desta intenção não possui mais estoque suficiente.')
  }

  const transactionId = newId('tx')
  const date = now.toISOString()
  const remaining = roundMoney(profile.availableLimit - intent.valorTotal)
  try {
    await db.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: tableName, Key: key(context.userId, 'PROFILE'), UpdateExpression: 'SET availableLimit = availableLimit - :amount', ConditionExpression: 'attribute_exists(PK) AND availableLimit >= :amount', ExpressionAttributeValues: { ':amount': intent.valorTotal } } },
      { Update: { TableName: tableName, Key: key(context.userId, 'INTENT#' + intentId), UpdateExpression: 'SET #status = :paid, paidAt = :date', ConditionExpression: 'attribute_exists(PK) AND #status = :pending AND userId = :user AND conversationId = :conversation AND expiresAt > :now', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':paid': 'paga', ':pending': 'pendente', ':date': date, ':user': context.userId, ':conversation': context.conversationId, ':now': Math.floor(now.getTime() / 1000) } } },
      { Update: { TableName: tableName, Key: { PK: 'CATALOG', SK: 'PRODUCT#' + intent.produtoId }, UpdateExpression: 'SET estoque = estoque - :quantity', ConditionExpression: 'attribute_exists(PK) AND estoque >= :quantity', ExpressionAttributeValues: { ':quantity': intent.quantidade } } },
      { Put: { TableName: tableName, Item: { ...key(context.userId, 'TRANSACTION#' + transactionId), entity: 'Transaction', transactionId, intencaoId: intentId, userId: context.userId, conversationId: context.conversationId, valor: intent.valorTotal, metodoPagamento: args.metodo_pagamento as Method, data: date }, ConditionExpression: 'attribute_not_exists(PK)' } },
    ] }))
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') throw error
    const [latestIntent, latestProfile, latestProduct] = await Promise.all([getIntent(context.userId, intentId), getProfile(context.userId), getProduct(intent.produtoId)])
    if (!latestIntent || latestIntent.conversationId !== context.conversationId) return refuse('INTENCAO_INVALIDA', 'A intenção informada não é válida para esta conversa.')
    if (latestIntent.status === 'paga') return refuse('INTENCAO_JA_PAGA', 'Esta intenção já foi utilizada em uma compra.')
    if (now.getTime() >= latestIntent.expiresAt * 1000) return refuse('INTENCAO_EXPIRADA', 'Esta intenção de compra expirou.')
    if (latestProfile && latestIntent.valorTotal > latestProfile.availableLimit) return refuse('LIMITE_EXCEDIDO', 'O valor da compra excede o limite disponível do usuário.')
    if (!latestProduct || latestProduct.estoque < latestIntent.quantidade) return refuse('INTENCAO_INVALIDA', 'O produto desta intenção não possui mais estoque suficiente.')
    throw error
  }
  const response = { status: 'aprovado' as const, transacao_id: transactionId, intencao_id: intentId, valor: intent.valorTotal, metodo_pagamento: args.metodo_pagamento as Method, limite_restante: remaining, data: date }
  await audit(context, 'realizar_compra', args, response)
  return response
}

