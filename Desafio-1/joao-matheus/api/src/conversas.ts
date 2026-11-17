/**
 * Handler para o endpoint GET /conversas.
 *
 * Retorna as últimas 50 mensagens trocadas pelo usuário autenticado em ordem cronológica.
 * O usuario_id é obtido exclusivamente do token Cognito (claims.sub).
 */

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from './historico';
import { cabecalhosCors } from './cors';

interface ConversasEvent {
  headers?: Record<string, string | undefined>;
  requestContext?: {
    authorizer?: {
      claims?: {
        sub?: string;
        [key: string]: any;
      };
    };
  };
}

interface ConversasResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export async function handler(event: ConversasEvent): Promise<ConversasResponse> {
  const cors = cabecalhosCors(event);
  const sub = event.requestContext?.authorizer?.claims?.sub;

  if (!sub) {
    return {
      statusCode: 401,
      headers: {
        'Content-Type': 'application/json',
        ...cors,
      },
      body: JSON.stringify({ mensagem: 'Usuário não autenticado.' }),
    };
  }

  const tabela = process.env.TABELA_CONVERSAS;
  if (!tabela) {
    console.error(JSON.stringify({ erro: 'ConfiguracaoInvalida', detalhe: 'TABELA_CONVERSAS não definida' }));
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        ...cors,
      },
      body: JSON.stringify({ mensagem: 'Erro interno de configuração do banco de dados.' }),
    };
  }

  try {
    const resp = await docClient.send(
      new QueryCommand({
        TableName: tabela,
        KeyConditionExpression: 'usuario_id = :u',
        ExpressionAttributeValues: {
          ':u': sub,
        },
        ScanIndexForward: false, // busca as 50 mais recentes
        Limit: 50,
      })
    );

    const itens = (resp.Items ?? []).reverse(); // inverte para ordem cronológica (mais antiga -> mais nova)

    const mensagens = itens.map((item) => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      texto: String(item.texto ?? ''),
      criado_em: item.criado_em ?? null,
    }));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        ...cors,
      },
      body: JSON.stringify({ mensagens }),
    };
  } catch (err: any) {
    console.error(
      JSON.stringify({
        erro: 'ErroConsultaConversas',
        mensagem: err.message,
        usuario_id: sub,
      })
    );

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        ...cors,
      },
      body: JSON.stringify({
        mensagem: 'Não foi possível carregar as conversas no momento.',
      }),
    };
  }
}
