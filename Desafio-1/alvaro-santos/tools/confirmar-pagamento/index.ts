import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

export type MetodoPagamento = 'cartao' | 'pix';

export type CodigoErroCompra =
  | 'INTENCAO_INVALIDA'
  | 'INTENCAO_EXPIRADA'
  | 'INTENCAO_JA_PAGA'
  | 'LIMITE_EXCEDIDO'
  | 'METODO_INVALIDO';

export interface ConfirmarPagamentoInput {
  readonly usuario_id?: string;
  readonly intencao_id?: string;
  readonly metodo_pagamento?: string;
}

export interface ConfirmarPagamentoAprovadoOutput {
  readonly status: 'aprovado';
  readonly transacao_id: string;
  readonly intencao_id: string;
  readonly valor: number;
  readonly metodo_pagamento: MetodoPagamento;
  readonly limite_restante: number;
  readonly data: string;
}

export interface ConfirmarPagamentoRecusadoOutput {
  readonly status: 'recusado';
  readonly erro: CodigoErroCompra;
  readonly codigo: CodigoErroCompra;
  readonly mensagem: string;
}

export type ConfirmarPagamentoOutput =
  | ConfirmarPagamentoAprovadoOutput
  | ConfirmarPagamentoRecusadoOutput;

export interface DynamoPaymentClient {
  send(command: GetCommand): Promise<{ Item?: Record<string, unknown> }>;
  send(command: TransactWriteCommand): Promise<unknown>;
}

interface TransactionCancellationReason {
  readonly Code?: string;
  readonly Message?: string;
}

interface ConditionalErrorLike {
  readonly name?: string;
  readonly CancellationReasons?: readonly TransactionCancellationReason[];
}

let defaultDocClient: DynamoDBDocumentClient | undefined;

function getDefaultDocClient(): DynamoDBDocumentClient {
  if (!defaultDocClient) {
    const client = new DynamoDBClient({});
    defaultDocClient = DynamoDBDocumentClient.from(client);
  }
  return defaultDocClient;
}

function buildRecusa(erro: CodigoErroCompra, mensagem: string): ConfirmarPagamentoRecusadoOutput {
  return {
    status: 'recusado',
    erro,
    codigo: erro,
    mensagem,
  };
}

function parseMetodoPagamento(rawMetodo: unknown): MetodoPagamento | undefined {
  if (typeof rawMetodo !== 'string') {
    return undefined;
  }
  const normalized = rawMetodo.trim().toLowerCase();
  if (normalized === 'pix' || normalized === 'cartao') {
    return normalized;
  }
  return undefined;
}

function mapTransactionFailure(err: unknown): ConfirmarPagamentoRecusadoOutput | undefined {
  if (!err || typeof err !== 'object') {
    return undefined;
  }

  const typedErr = err as ConditionalErrorLike;
  if (typedErr.name === 'TransactionCanceledException') {
    const reasons = typedErr.CancellationReasons ?? [];
    if (reasons[0]?.Code === 'ConditionalCheckFailed') {
      return buildRecusa(
        'INTENCAO_JA_PAGA',
        'Esta intenção de compra já foi liquidada, expirada ou invalidada em outra tentativa.',
      );
    }
    if (reasons[1]?.Code === 'ConditionalCheckFailed') {
      return buildRecusa(
        'LIMITE_EXCEDIDO',
        'Saldo/limite disponível insuficiente para cobrir o valor desta compra.',
      );
    }
  }

  if (typedErr.name === 'ConditionalCheckFailedException') {
    return buildRecusa(
      'LIMITE_EXCEDIDO',
      'Condição financeira não satisfeita ao liquidar o pagamento.',
    );
  }

  return undefined;
}

/**
 * Factory da TOOL-03 (Liquidação Atômica e Idempotente) para permitir testes unitários sem rede.
 */
export function createHandler(docClient?: DynamoPaymentClient, nowFn: () => number = () => Date.now()) {
  return async (event: ConfirmarPagamentoInput): Promise<ConfirmarPagamentoOutput> => {
    const usuarioId = typeof event?.usuario_id === 'string' ? event.usuario_id.trim() : '';
    if (!usuarioId) {
      throw new Error('Parâmetro obrigatório ausente: usuario_id deve ser fornecido pelo runtime autorizado.');
    }

    const intencoesTableName = process.env.INTENCOES_TABLE_NAME;
    const usuariosTableName = process.env.USUARIOS_TABLE_NAME;
    if (!intencoesTableName || !usuariosTableName) {
      throw new Error(
        'Variáveis de ambiente obrigatórias ausentes: INTENCOES_TABLE_NAME e USUARIOS_TABLE_NAME.',
      );
    }

    const metodoPagamento = parseMetodoPagamento(event?.metodo_pagamento);
    if (!metodoPagamento) {
      return buildRecusa(
        'METODO_INVALIDO',
        'Método de pagamento inválido. Escolha exatamente "pix" ou "cartao".',
      );
    }

    const intencaoId = typeof event?.intencao_id === 'string' ? event.intencao_id.trim() : '';
    if (!intencaoId) {
      return buildRecusa('INTENCAO_INVALIDA', 'Identificador de intenção de compra ausente ou inválido.');
    }

    const client = docClient ?? (getDefaultDocClient() as unknown as DynamoPaymentClient);
    const nowMs = nowFn();
    const nowEpochSec = Math.floor(nowMs / 1000);

    // 1. Leitura prévia para recuperar valor determinístico da intenção e dar mensagens claras
    const intencaoResult = await client.send(
      new GetCommand({
        TableName: intencoesTableName,
        Key: { intencao_id: intencaoId },
        ConsistentRead: true,
      }),
    );

    const item = intencaoResult.Item;
    if (!item || item.usuario_id !== usuarioId) {
      return buildRecusa(
        'INTENCAO_INVALIDA',
        'Intenção de compra não encontrada para o usuário autenticado.',
      );
    }

    if (item.status === 'PAGO') {
      return buildRecusa(
        'INTENCAO_JA_PAGA',
        'Esta intenção de compra já foi paga anteriormente. Nenhuma nova cobrança foi realizada.',
      );
    }

    if (item.status !== 'PENDENTE') {
      return buildRecusa(
        'INTENCAO_INVALIDA',
        'Esta intenção de compra não está disponível para pagamento.',
      );
    }

    if (typeof item.expires_at === 'number' && nowEpochSec >= item.expires_at) {
      return buildRecusa(
        'INTENCAO_EXPIRADA',
        'Esta intenção de compra expirou. Registre uma nova intenção antes de pagar.',
      );
    }

    const valorTotal = typeof item.valor_total === 'number' ? item.valor_total : Number(item.valor_total);
    if (!Number.isFinite(valorTotal) || valorTotal <= 0) {
      return buildRecusa('INTENCAO_INVALIDA', 'Valor registrado na intenção é inválido.');
    }

    const transacaoId = `tx_${randomUUID()}`;
    const dataIso = new Date(nowMs).toISOString();

    // 2. Liquidação atômica + idempotência: atualiza intenção para PAGO e debita saldo na mesma transação
    try {
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: intencoesTableName,
                Key: { intencao_id: intencaoId },
                UpdateExpression:
                  'SET #status = :pago, transacao_id = :txId, metodo_pagamento = :metodo, pago_em = :pagoEm',
                ConditionExpression:
                  'attribute_exists(intencao_id) AND usuario_id = :usuarioId AND #status = :pendente AND expires_at > :nowEpochSec',
                ExpressionAttributeNames: {
                  '#status': 'status',
                },
                ExpressionAttributeValues: {
                  ':pago': 'PAGO',
                  ':pendente': 'PENDENTE',
                  ':usuarioId': usuarioId,
                  ':nowEpochSec': nowEpochSec,
                  ':txId': transacaoId,
                  ':metodo': metodoPagamento,
                  ':pagoEm': dataIso,
                },
              },
            },
            {
              Update: {
                TableName: usuariosTableName,
                Key: { usuario_id: usuarioId },
                UpdateExpression: 'SET saldo_disponivel = saldo_disponivel - :valor, atualizado_em = :pagoEm',
                ConditionExpression: 'attribute_exists(usuario_id) AND saldo_disponivel >= :valor',
                ExpressionAttributeValues: {
                  ':valor': valorTotal,
                  ':pagoEm': dataIso,
                },
              },
            },
          ],
        }),
      );
    } catch (err) {
      const mapped = mapTransactionFailure(err);
      if (mapped) {
        return mapped;
      }
      throw err;
    }

    // 3. Leitura consistente do saldo remanescente para compor o comprovante oficial
    const userResult = await client.send(
      new GetCommand({
        TableName: usuariosTableName,
        Key: { usuario_id: usuarioId },
        ProjectionExpression: 'saldo_disponivel',
        ConsistentRead: true,
      }),
    );

    const rawRemaining = userResult.Item?.saldo_disponivel;
    const limiteRestante =
      typeof rawRemaining === 'number' && Number.isFinite(rawRemaining)
        ? Number(rawRemaining.toFixed(2))
        : 0;

    return {
      status: 'aprovado',
      transacao_id: transacaoId,
      intencao_id: intencaoId,
      valor: Number(valorTotal.toFixed(2)),
      metodo_pagamento: metodoPagamento,
      limite_restante: limiteRestante,
      data: dataIso,
    };
  };
}

export const handler = createHandler();
