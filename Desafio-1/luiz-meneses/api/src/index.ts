/**
 * Lambdas do webchat, atrás do API Gateway (autorizador Cognito).
 *
 * - chat:      POST /chat      -> resposta em streaming (texto aparece aos poucos no front)
 * - conversas: GET  /conversas -> histórico do usuário para a tela
 *
 * O usuario_id SEMPRE vem do token validado pelo API Gateway (claim "sub"), nunca do corpo.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Writable } from 'node:stream';

declare const awslambda: {
  streamifyResponse: (
    h: (event: APIGatewayProxyEvent, stream: Writable, ctx: unknown) => Promise<void>,
  ) => unknown;
  HttpResponseStream: {
    from: (stream: Writable, meta: { statusCode: number; headers?: Record<string, string> }) => Writable;
  };
};

const TABELA = process.env.TABELA_CONVERSAS!;
const RUNTIME_ARN = process.env.AGENT_RUNTIME_ARN!;
const RUNTIME_VERSION = process.env.AGENT_RUNTIME_VERSION ?? '1';
const ORIGEM = process.env.ALLOWED_ORIGIN!;
const MAX_MENSAGEM = 2000;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const agentcore = new BedrockAgentCoreClient({});

const cors = {
  'Access-Control-Allow-Origin': ORIGEM,
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

type Mensagem = { role: 'user' | 'assistant'; content: Array<Record<string, unknown>> };

function usuarioDoToken(event: APIGatewayProxyEvent): string | undefined {
  const sub = event.requestContext?.authorizer?.claims?.sub;
  return typeof sub === 'string' && sub ? sub : undefined;
}

async function carregarHistorico(usuarioId: string): Promise<Mensagem[]> {
  const mensagens: Mensagem[] = [];
  let inicio: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(
      new QueryCommand({
        TableName: TABELA,
        KeyConditionExpression: 'usuario_id = :u',
        ExpressionAttributeValues: { ':u': usuarioId },
        ConsistentRead: true,
        ExclusiveStartKey: inicio,
      }),
    );
    for (const item of r.Items ?? []) mensagens.push(JSON.parse(item.mensagem as string));
    inicio = r.LastEvaluatedKey;
  } while (inicio);
  return mensagens;
}

async function salvarMensagens(usuarioId: string, novas: Mensagem[]) {
  const base = new Date().toISOString();
  const itens = novas.map((m, i) => ({
    PutRequest: {
      // A ordenação vem da sort key: horário do turno + posição dentro dele.
      Item: { usuario_id: usuarioId, ordem: `${base}#${String(i).padStart(3, '0')}`, mensagem: JSON.stringify(m) },
    },
  }));
  for (let i = 0; i < itens.length; i += 25) {
    await ddb.send(new BatchWriteCommand({ RequestItems: { [TABELA]: itens.slice(i, i + 25) } }));
  }
}

/** Lê o SSE do AgentCore ("data: {...}\n\n") e devolve cada evento já convertido em objeto. */
async function* eventosDoAgente(corpo: AsyncIterable<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const pedaco of corpo) {
    buffer += decoder.decode(pedaco, { stream: true });
    let fim: number;
    while ((fim = buffer.indexOf('\n\n')) >= 0) {
      const bloco = buffer.slice(0, fim);
      buffer = buffer.slice(fim + 2);
      for (const linha of bloco.split('\n')) {
        if (linha.startsWith('data: ')) yield JSON.parse(linha.slice(6));
      }
    }
  }
}

export const chat = awslambda.streamifyResponse(async (event, responseStream) => {
  const usuarioId = usuarioDoToken(event);
  let mensagem = '';
  try {
    mensagem = String(JSON.parse(event.body ?? '{}').message ?? '').trim();
  } catch {
    /* corpo inválido cai na validação abaixo */
  }

  const erro = (status: number, texto: string) => {
    const s = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
    s.write(JSON.stringify({ detail: texto }));
    s.end();
  };
  // O API Gateway já barrou quem não tem token; isto é defesa em profundidade.
  if (!usuarioId) return erro(401, 'Não autenticado.');
  if (!mensagem || mensagem.length > MAX_MENSAGEM) return erro(400, 'Mensagem vazia ou longa demais.');

  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' },
  });

  try {
    const historico = await carregarHistorico(usuarioId);
    const resp = await agentcore.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: RUNTIME_ARN,
        runtimeSessionId: `chatpay-v${RUNTIME_VERSION}-${usuarioId}`, // mínimo de 33 caracteres; nova sessão a cada versão do agente
        contentType: 'application/json',
        accept: 'text/event-stream',
        payload: new TextEncoder().encode(JSON.stringify({ usuario_id: usuarioId, mensagem, historico })),
      }),
    );

    let novas: Mensagem[] | undefined;
    for await (const ev of eventosDoAgente(resp.response as AsyncIterable<Uint8Array>)) {
      if (ev.tipo === 'texto') stream.write(ev.texto);
      else if (ev.tipo === 'fim') novas = ev.mensagens;
      else if (ev.tipo === 'erro' || ev.error) stream.write(ev.mensagem ?? 'O assistente teve um problema para responder.');
    }
    // Só grava o turno se ele terminou inteiro: histórico nunca fica com pedido de tool sem resposta.
    if (novas?.length) await salvarMensagens(usuarioId, novas);
  } catch (e) {
    console.error('ERRO chat', e);
    stream.write('\n\nNão foi possível falar com o assistente agora. Tente novamente em instantes.');
  } finally {
    stream.end();
  }
});

export async function conversas(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const usuarioId = usuarioDoToken(event);
  if (!usuarioId) return { statusCode: 401, headers: cors, body: JSON.stringify({ detail: 'Não autenticado.' }) };
  try {
    const historico = await carregarHistorico(usuarioId);
    // Para a tela, só os textos; chamadas e resultados de tool ficam guardados mas não aparecem.
    const messages = historico
      .map((m) => ({
        role: m.role,
        content: m.content.map((b) => (typeof b.text === 'string' ? b.text : '')).join(''),
      }))
      .filter((m) => m.content.trim());
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }) };
  } catch (e) {
    console.error('ERRO conversas', e);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ detail: 'Erro ao carregar o histórico.' }) };
  }
}
