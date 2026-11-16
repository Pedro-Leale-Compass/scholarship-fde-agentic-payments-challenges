/**
 * Handler de streaming para o endpoint POST /chat.
 *
 * Utiliza Lambda Response Streaming (awslambda.streamifyResponse) para repassar
 * deltas SSE em tempo real do Bedrock AgentCore Runtime para o cliente HTTP/navegador.
 *
 * O usuario_id é obtido exclusivamente do token Cognito (claims.sub) pelo autorizador.
 */

import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { obterOrigemPermitida } from './cors';
import { formatarSse, SseParser, EventoSSE } from './sse';
import { carregarHistorico, salvarTurno } from './historico';

const agentCore = new BedrockAgentCoreClient({
  region: process.env.AWS_REGION || 'us-east-1',
});

interface ChatEvent {
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
  requestContext?: {
    authorizer?: {
      claims?: {
        sub?: string;
        email?: string;
        [key: string]: any;
      };
    };
  };
}

export const handler = awslambda.streamifyResponse(async (event: ChatEvent, responseStream) => {
  const origem = obterOrigemPermitida(event);
  const sub = event.requestContext?.authorizer?.claims?.sub;

  const http = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: sub ? 200 : 401,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Access-Control-Allow-Origin': origem,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      Vary: 'Origin',
    },
  });

  const inicioTurno = new Date().toISOString();

  // 1. Defesa em profundidade: validação do sub do autorizador Cognito
  if (!sub) {
    http.write(formatarSse({ tipo: 'erro', mensagem: 'Usuário não autenticado.' }));
    http.write(formatarSse({ tipo: 'fim' }));
    http.end();
    return;
  }

  // 2. Extração e validação do corpo da requisição
  let mensagem = '';
  try {
    const rawBody = event.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf-8')
      : event.body || '{}';

    const parsed = JSON.parse(rawBody);
    mensagem = typeof parsed.mensagem === 'string' ? parsed.mensagem.trim() : '';
  } catch {
    http.write(formatarSse({ tipo: 'erro', mensagem: 'Corpo da requisição inválido. JSON esperado.' }));
    http.write(formatarSse({ tipo: 'fim' }));
    http.end();
    return;
  }

  if (!mensagem || mensagem.length > 2000) {
    http.write(
      formatarSse({
        tipo: 'erro',
        mensagem: 'A mensagem deve conter entre 1 e 2000 caracteres.',
      })
    );
    http.write(formatarSse({ tipo: 'fim' }));
    http.end();
    return;
  }

  const agentRuntimeArn = process.env.AGENT_RUNTIME_ARN;
  if (!agentRuntimeArn) {
    console.error(JSON.stringify({ erro: 'ConfiguracaoInvalida', detalhe: 'AGENT_RUNTIME_ARN não definida' }));
    http.write(formatarSse({ tipo: 'erro', mensagem: 'Erro interno de configuração do agente.' }));
    http.write(formatarSse({ tipo: 'fim' }));
    http.end();
    return;
  }

  let textoAcumulado = '';
  let recebeuFim = false;

  try {
    // 3. Carregar histórico do usuário no DynamoDB (últimas 30 mensagens)
    const historico = await carregarHistorico(sub, 30);

    // 4. Invocação do Bedrock AgentCore Runtime com streaming
    // runtimeSessionId deve ter >= 33 caracteres
    const runtimeSessionId = `sessao-${sub}`.padEnd(36, '0');

    const comando = new InvokeAgentRuntimeCommand({
      agentRuntimeArn,
      runtimeSessionId,
      contentType: 'application/json',
      accept: 'text/event-stream',
      payload: Buffer.from(
        JSON.stringify({
          prompt: mensagem,
          usuario_id: sub,
          historico,
        })
      ),
    });

    const resposta = await agentCore.send(comando);

    // Se o runtime retornar JSON direto (ex: erro inicial de validação)
    if (resposta.contentType?.includes('application/json')) {
      let corpoErro = '';
      if (resposta.response) {
        for await (const chunk of resposta.response as AsyncIterable<Uint8Array | string>) {
          corpoErro += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
        }
      }
      console.warn(JSON.stringify({ aviso: 'RespostaNaoSseDoRuntime', conteudo: corpoErro }));
      http.write(formatarSse({ tipo: 'erro', mensagem: 'Não foi possível processar com o assistente.' }));
      http.write(formatarSse({ tipo: 'fim' }));
      return;
    }

    if (!resposta.response) {
      http.write(formatarSse({ tipo: 'erro', mensagem: 'Resposta vazia do agente.' }));
      http.write(formatarSse({ tipo: 'fim' }));
      return;
    }

    // 5. Consumir chunks do streaming e repassar eventos SSE
    const parser = new SseParser();

    for await (const chunk of resposta.response as AsyncIterable<Uint8Array | string>) {
      const eventos = parser.alimentar(chunk);
      for (const ev of eventos) {
        http.write(formatarSse(ev));

        if (ev.tipo === 'delta' && typeof (ev as any).texto === 'string') {
          textoAcumulado += (ev as any).texto;
        } else if (ev.tipo === 'fim') {
          recebeuFim = true;
        }
      }
    }

    // Processar qualquer evento restante no buffer
    const eventosRestantes = parser.finalizar();
    for (const ev of eventosRestantes) {
      http.write(formatarSse(ev));
      if (ev.tipo === 'delta' && typeof (ev as any).texto === 'string') {
        textoAcumulado += (ev as any).texto;
      } else if (ev.tipo === 'fim') {
        recebeuFim = true;
      }
    }

    if (!recebeuFim) {
      http.write(formatarSse({ tipo: 'fim' }));
    }

    // 6. Persistir turno no DynamoDB se a resposta foi gerada com sucesso
    if (textoAcumulado.trim().length > 0) {
      try {
        await salvarTurno(sub, mensagem, textoAcumulado, inicioTurno, new Date().toISOString());
      } catch (errDb: any) {
        console.error(
          JSON.stringify({
            erro: 'FalhaPersistenciaHistorico',
            mensagem: errDb.message,
            usuario_id: sub,
          })
        );
      }
    }
  } catch (err: any) {
    console.error(
      JSON.stringify({
        erro: err.name || 'ErroInvocacaoAgente',
        mensagem: err.message,
        timestamp: new Date().toISOString(),
      })
    );
    http.write(
      formatarSse({
        tipo: 'erro',
        mensagem: 'Não foi possível concluir a resposta no momento. Tente novamente.',
      })
    );
    http.write(formatarSse({ tipo: 'fim' }));
  } finally {
    http.end();
  }
});
