/**
 * Gerenciamento do histórico de conversas no DynamoDB (tabela joao-matheus-conversas).
 *
 * Cada mensagem é persistida individualmente com SK ordenável por timestamp ISO:
 * PK: usuario_id
 * SK: MSG#<ISO-8601>#<random4>
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { randomBytes } from 'crypto';

export interface MensagemHistorico {
  role: 'user' | 'assistant';
  texto: string;
  criado_em?: string;
}

const dynamoClient = new DynamoDBClient({});
export const docClient = DynamoDBDocumentClient.from(dynamoClient);

/**
 * Sanitiza o histórico garantindo que a primeira mensagem seja sempre do usuário,
 * conforme exigência dos modelos Bedrock.
 */
export function sanitizarHistorico(mensagens: MensagemHistorico[]): MensagemHistorico[] {
  const primeiroUserIdx = mensagens.findIndex((m) => m.role === 'user');
  if (primeiroUserIdx === -1) {
    return [];
  }
  return mensagens.slice(primeiroUserIdx);
}

/**
 * Carrega até `limite` mensagens recentes do DynamoDB em ordem cronológica,
 * garantindo início com mensagem de papel 'user'.
 */
export async function carregarHistorico(
  usuarioId: string,
  limite = 30,
  tabela = process.env.TABELA_CONVERSAS
): Promise<MensagemHistorico[]> {
  if (!tabela) {
    throw new Error('Variável de ambiente TABELA_CONVERSAS não definida');
  }

  const resp = await docClient.send(
    new QueryCommand({
      TableName: tabela,
      KeyConditionExpression: 'usuario_id = :u',
      ExpressionAttributeValues: {
        ':u': usuarioId,
      },
      ScanIndexForward: false, // busca as mais recentes primeiro
      Limit: limite,
    })
  );

  const itens = (resp.Items ?? []).reverse(); // inverte para ordem cronológica (mais antiga -> mais nova)

  const mensagens: MensagemHistorico[] = itens.map((item) => ({
    role: item.role === 'assistant' ? 'assistant' : 'user',
    texto: String(item.texto ?? ''),
    criado_em: item.criado_em,
  }));

  return sanitizarHistorico(mensagens);
}

/**
 * Salva um turno completo (pergunta do usuário + resposta do assistente) de forma atômica/em lote.
 * O timestamp do usuário reflete o início do turno e o do assistente o fim, garantindo ordenação perfeita.
 */
export async function salvarTurno(
  usuarioId: string,
  mensagemUsuario: string,
  respostaAssistente: string,
  dataInicio?: string,
  dataFim?: string,
  tabela = process.env.TABELA_CONVERSAS
): Promise<void> {
  if (!tabela) {
    throw new Error('Variável de ambiente TABELA_CONVERSAS não definida');
  }

  const isoInicio = dataInicio || new Date().toISOString();
  const isoFim = dataFim || new Date().toISOString();
  const randUser = randomBytes(2).toString('hex');
  const randAssis = randomBytes(2).toString('hex');

  await docClient.send(
    new BatchWriteCommand({
      RequestItems: {
        [tabela]: [
          {
            PutRequest: {
              Item: {
                usuario_id: usuarioId,
                sk: `MSG#${isoInicio}#${randUser}`,
                role: 'user',
                texto: mensagemUsuario,
                criado_em: isoInicio,
              },
            },
          },
          {
            PutRequest: {
              Item: {
                usuario_id: usuarioId,
                sk: `MSG#${isoFim}#${randAssis}`,
                role: 'assistant',
                texto: respostaAssistente,
                criado_em: isoFim,
              },
            },
          },
        ],
      },
    })
  );
}
