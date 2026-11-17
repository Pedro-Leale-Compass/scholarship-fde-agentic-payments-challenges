import { randomBytes } from 'node:crypto'
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import { CONDITIONAL_CHECK_FAILED, createDocClient, getNomeErro, requireEnv } from './shared/dynamo.ts'
import { parseArgumentos, parseConversa, parseUsuario } from './shared/contexto.ts'
import { createHandler, createRecusa, type Recusa } from './shared/resposta.ts'
import type { Intencao } from './register-intencao.ts'

export const LIMITE_PADRAO_CENTS = 100_000
const TRANSACTION_CANCELED = 'TransactionCanceledException'
const INDICE = { intencao: 0, usuario: 1, estoque: 2, transacao: 3 } as const

const MENSAGEM = {
  invalida: 'Intenção inválida para o usuário autenticado.',
  semEstoque: 'O estoque desta intenção não está mais disponível. Registre uma nova intenção.',
  jaPaga: 'Esta intenção de compra já foi utilizada.',
  expirada: 'Esta intenção de compra expirou. Registre uma nova intenção.',
  metodo: 'Método de pagamento inválido. Escolha cartao ou pix.',
  limite: 'O valor da compra excede o limite restante.',
} as const

export type Tabelas = { usuarios: string; catalogo: string; intencoes: string; transacoes: string }

export type MetodoPagamento = 'cartao' | 'pix'

export type RecusaCompra = Recusa<
  'INTENCAO_INVALIDA' | 'INTENCAO_EXPIRADA' | 'INTENCAO_JA_PAGA' | 'LIMITE_EXCEDIDO' | 'METODO_INVALIDO'
>

export type CompraAprovada = {
  status: 'aprovado'
  transacao_id: string
  intencao_id: string
  valor: number
  metodo_pagamento: MetodoPagamento
  limite_restante: number
  data: string
}

export type Usuario = {
  usuario_id: string
  limite_cents: number
  saldo_cents: number
  criado_em: string
}

export type Transacao = {
  transacao_id: string
  intencao_id: string
  usuario_id: string
  valor_cents: number
  metodo_pagamento: MetodoPagamento
  data: string
}

export function createTransacaoId(): string {
  return `tx_${randomBytes(8).toString('hex')}`
}

async function getIntencao(db: DynamoDBDocumentClient, tabela: string, intencaoId: string) {
  const { Item } = await db.send(
    new GetCommand({ TableName: tabela, Key: { intencao_id: intencaoId }, ConsistentRead: true }),
  )
  return Item as Intencao | undefined
}

async function getUsuario(db: DynamoDBDocumentClient, tabela: string, usuarioId: string) {
  const { Item } = await db.send(
    new GetCommand({ TableName: tabela, Key: { usuario_id: usuarioId }, ConsistentRead: true }),
  )
  return Item as Usuario | undefined
}

function validateStatusIntencao(intencao: Intencao, agora: Date): RecusaCompra | undefined {
  if (intencao.status === 'cancelada_estoque') return createRecusa('INTENCAO_INVALIDA', MENSAGEM.semEstoque)
  if (intencao.status !== 'pendente') return createRecusa('INTENCAO_JA_PAGA', MENSAGEM.jaPaga)
  if (agora.toISOString() >= intencao.expira_em) return createRecusa('INTENCAO_EXPIRADA', MENSAGEM.expirada)
  return undefined
}

export async function ensureUsuario(
  db: DynamoDBDocumentClient,
  tabela: string,
  usuarioId: string,
  limiteCents: number,
  agora: Date,
): Promise<void> {
  const usuario: Usuario = {
    usuario_id: usuarioId,
    limite_cents: limiteCents,
    saldo_cents: limiteCents,
    criado_em: agora.toISOString(),
  }
  try {
    await db.send(
      new PutCommand({ TableName: tabela, Item: usuario, ConditionExpression: 'attribute_not_exists(usuario_id)' }),
    )
  } catch (erro) {
    if (getNomeErro(erro) !== CONDITIONAL_CHECK_FAILED) throw erro
  }
}

async function cancelIntencao(db: DynamoDBDocumentClient, tabela: string, intencaoId: string): Promise<void> {
  try {
    await db.send(
      new UpdateCommand({
        TableName: tabela,
        Key: { intencao_id: intencaoId },
        UpdateExpression: 'SET #status = :cancelada',
        ConditionExpression: '#status = :pendente',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':cancelada': 'cancelada_estoque', ':pendente': 'pendente' },
      }),
    )
  } catch (erro) {
    if (getNomeErro(erro) !== CONDITIONAL_CHECK_FAILED) throw erro
  }
}

async function resolveCancelamento(
  db: DynamoDBDocumentClient,
  tabelas: Tabelas,
  intencao: Intencao,
  erro: unknown,
  agora: Date,
): Promise<RecusaCompra> {
  const motivos = ((erro as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).map(
    (motivo) => motivo.Code,
  )
  const falhou = (indice: number) => motivos[indice] === 'ConditionalCheckFailed'
  const conflito = motivos.includes('TransactionConflict')

  if (falhou(INDICE.intencao) || conflito) {
    const atual = await getIntencao(db, tabelas.intencoes, intencao.intencao_id)
    const recusa = atual ? validateStatusIntencao(atual, agora) : createRecusa('INTENCAO_INVALIDA', MENSAGEM.invalida)
    if (recusa) return recusa
    if (falhou(INDICE.intencao)) return createRecusa('INTENCAO_INVALIDA', MENSAGEM.invalida)
    throw erro
  }

  if (falhou(INDICE.usuario)) return createRecusa('LIMITE_EXCEDIDO', MENSAGEM.limite)

  if (falhou(INDICE.estoque)) {
    await cancelIntencao(db, tabelas.intencoes, intencao.intencao_id)
    return createRecusa('INTENCAO_INVALIDA', MENSAGEM.semEstoque)
  }

  throw erro
}

export async function createCompra(
  db: DynamoDBDocumentClient,
  tabelas: Tabelas,
  usuarioId: string,
  conversaId: string,
  args: Record<string, unknown>,
  agora = new Date(),
  limitePadraoCents = LIMITE_PADRAO_CENTS,
): Promise<CompraAprovada | RecusaCompra> {
  const intencaoId = typeof args.intencao_id === 'string' ? args.intencao_id.trim() : ''
  if (!intencaoId) return createRecusa('INTENCAO_INVALIDA', MENSAGEM.invalida)

  const intencao = await getIntencao(db, tabelas.intencoes, intencaoId)
  if (!intencao || intencao.usuario_id !== usuarioId || intencao.conversa_id !== conversaId) {
    return createRecusa('INTENCAO_INVALIDA', MENSAGEM.invalida)
  }

  const recusaStatus = validateStatusIntencao(intencao, agora)
  if (recusaStatus) return recusaStatus

  const metodo = args.metodo_pagamento
  if (metodo !== 'cartao' && metodo !== 'pix') return createRecusa('METODO_INVALIDO', MENSAGEM.metodo)

  await ensureUsuario(db, tabelas.usuarios, usuarioId, limitePadraoCents, agora)

  const transacao: Transacao = {
    transacao_id: createTransacaoId(),
    intencao_id: intencao.intencao_id,
    usuario_id: usuarioId,
    valor_cents: intencao.valor_total_cents,
    metodo_pagamento: metodo,
    data: agora.toISOString(),
  }

  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tabelas.intencoes,
              Key: { intencao_id: intencao.intencao_id },
              UpdateExpression: 'SET #status = :paga, transacao_id = :transacao',
              ConditionExpression:
                '#status = :pendente AND usuario_id = :usuario AND conversa_id = :conversa AND expira_em > :agora',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':paga': 'paga',
                ':pendente': 'pendente',
                ':transacao': transacao.transacao_id,
                ':usuario': usuarioId,
                ':conversa': conversaId,
                ':agora': transacao.data,
              },
            },
          },
          {
            Update: {
              TableName: tabelas.usuarios,
              Key: { usuario_id: usuarioId },
              UpdateExpression: 'SET saldo_cents = saldo_cents - :valor',
              ConditionExpression: 'saldo_cents >= :valor',
              ExpressionAttributeValues: { ':valor': transacao.valor_cents },
            },
          },
          {
            Update: {
              TableName: tabelas.catalogo,
              Key: { produto_id: intencao.produto_id },
              UpdateExpression: 'SET estoque = estoque - :quantidade',
              ConditionExpression: 'estoque >= :quantidade',
              ExpressionAttributeValues: { ':quantidade': intencao.quantidade },
            },
          },
          {
            Put: {
              TableName: tabelas.transacoes,
              Item: transacao,
              ConditionExpression: 'attribute_not_exists(transacao_id)',
            },
          },
        ],
      }),
    )
  } catch (erro) {
    if (getNomeErro(erro) !== TRANSACTION_CANCELED) throw erro
    return resolveCancelamento(db, tabelas, intencao, erro, agora)
  }

  const usuario = await getUsuario(db, tabelas.usuarios, usuarioId)
  if (!usuario) throw new Error('usuário não encontrado após a compra')

  return {
    status: 'aprovado',
    transacao_id: transacao.transacao_id,
    intencao_id: intencao.intencao_id,
    valor: transacao.valor_cents / 100,
    metodo_pagamento: metodo,
    limite_restante: usuario.saldo_cents / 100,
    data: transacao.data,
  }
}

export function parseLimitePadrao(valor: string | undefined): number {
  if (!valor?.trim()) return LIMITE_PADRAO_CENTS
  const limite = Number(valor)
  if (!Number.isSafeInteger(limite) || limite < 0) {
    throw new Error('LIMITE_PADRAO_CENTS deve ser um inteiro não negativo')
  }
  return limite
}

const db = createDocClient()

export const handler = createHandler('realizar_compra', async (evento) =>
  createCompra(
    db,
    {
      usuarios: requireEnv('TABELA_USUARIOS'),
      catalogo: requireEnv('TABELA_CATALOGO'),
      intencoes: requireEnv('TABELA_INTENCOES'),
      transacoes: requireEnv('TABELA_TRANSACOES'),
    },
    parseUsuario(evento),
    parseConversa(evento),
    parseArgumentos(evento),
    new Date(),
    parseLimitePadrao(process.env.LIMITE_PADRAO_CENTS),
  ),
)
