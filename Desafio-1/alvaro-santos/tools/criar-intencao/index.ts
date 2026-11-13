import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { findCatalogProductById } from '../shared/catalog';

const INTENCAO_TTL_SECONDS = 15 * 60;

export interface CriarIntencaoInput {
  readonly usuario_id?: string;
  readonly produto_id?: string;
  readonly quantidade?: number;
}

export interface CriarIntencaoOutput {
  readonly intencao_id: string;
  readonly produto_id: string;
  readonly produto_nome: string;
  readonly quantidade: number;
  readonly valor_total: number;
  readonly moeda: 'BRL';
  readonly status: 'PENDENTE';
  readonly expira_em: string;
  readonly mensagem: string;
}

export interface DynamoPutClient {
  send(command: PutCommand): Promise<unknown>;
}

let defaultDocClient: DynamoDBDocumentClient | undefined;

function getDefaultDocClient(): DynamoDBDocumentClient {
  if (!defaultDocClient) {
    const client = new DynamoDBClient({});
    defaultDocClient = DynamoDBDocumentClient.from(client);
  }
  return defaultDocClient;
}

/**
 * Factory do handler da TOOL-02 para permitir injeção do cliente DynamoDB em testes unitários.
 */
export function createHandler(docClient?: DynamoPutClient, nowFn: () => number = () => Date.now()) {
  return async (event: CriarIntencaoInput): Promise<CriarIntencaoOutput> => {
    const usuarioId = typeof event?.usuario_id === 'string' ? event.usuario_id.trim() : '';
    if (!usuarioId) {
      throw new Error('Parâmetro obrigatório ausente: usuario_id deve ser fornecido pelo runtime autorizado.');
    }

    const produtoId = typeof event?.produto_id === 'string' ? event.produto_id.trim() : '';
    if (!produtoId) {
      throw new Error('Parâmetro obrigatório ausente: produto_id.');
    }

    const product = findCatalogProductById(produtoId);
    if (!product) {
      throw new Error(`Produto não encontrado no catálogo oficial: ${produtoId}.`);
    }

    const quantidade = event?.quantidade;
    if (typeof quantidade !== 'number' || !Number.isInteger(quantidade) || quantidade < 1) {
      throw new Error('Parâmetro inválido: quantidade deve ser um número inteiro maior ou igual a 1.');
    }

    if (quantidade > product.estoque) {
      throw new Error(
        `Estoque insuficiente para ${product.nome}: solicitado ${quantidade}, disponível ${product.estoque}.`,
      );
    }

    const tableName = process.env.INTENCOES_TABLE_NAME;
    if (!tableName) {
      throw new Error('Variável de ambiente obrigatória ausente: INTENCOES_TABLE_NAME.');
    }

    // Cálculo 100% determinístico no backend (nunca confia em preço vindo do cliente/LLM).
    const valorTotal = Number((product.preco * quantidade).toFixed(2));
    const intencaoId = randomUUID();
    const nowMs = nowFn();
    const nowEpochSec = Math.floor(nowMs / 1000);
    const expiresAtEpochSec = nowEpochSec + INTENCAO_TTL_SECONDS;
    const criadoEm = new Date(nowMs).toISOString();
    const expiraEm = new Date(expiresAtEpochSec * 1000).toISOString();

    const client = docClient ?? getDefaultDocClient();
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          intencao_id: intencaoId,
          usuario_id: usuarioId,
          produto_id: product.id,
          produto_nome: product.nome,
          quantidade,
          preco_unitario: product.preco,
          valor_total: valorTotal,
          moeda: product.moeda,
          status: 'PENDENTE',
          criado_em: criadoEm,
          expira_em: expiraEm,
          expires_at: expiresAtEpochSec,
        },
        ConditionExpression: 'attribute_not_exists(intencao_id)',
      }),
    );

    return {
      intencao_id: intencaoId,
      produto_id: product.id,
      produto_nome: product.nome,
      quantidade,
      valor_total: valorTotal,
      moeda: product.moeda,
      status: 'PENDENTE',
      expira_em: expiraEm,
      mensagem:
        `Intenção ${intencaoId} registrada para ${quantidade}x ${product.nome} no valor de R$ ${valorTotal.toFixed(2)}. Solicite confirmação explícita do usuário e o método de pagamento (pix ou cartao) antes de confirmar.`,
    };
  };
}

export const handler = createHandler();
