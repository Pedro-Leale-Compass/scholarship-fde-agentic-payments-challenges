import http from 'node:http';
import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import type { Message, ContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { runAgent, SYSTEM, TOOLS } from './engine.ts';
import type { Dependencies } from './engine.ts';
import { auditTools } from './tool-audit.ts';

const bedrock = new BedrockRuntimeClient({ region: 'us-east-1', maxAttempts: 2 });
const lambda = new LambdaClient({ region: 'us-east-1', maxAttempts: 1 });
const dependencies: Dependencies = {
  async infer(messages, emit) {
    const response = await bedrock.send(new ConverseStreamCommand({ modelId: process.env.MODEL_ID,
      messages, system: [{ text: SYSTEM }], toolConfig: { tools: TOOLS }, inferenceConfig: { maxTokens: 1200, temperature: 0.2 } }), { abortSignal: AbortSignal.timeout(60000) });
    const blocks = new Map<number, { text?: string; toolUse?: { toolUseId: string; name: string; input: string } }>();
    let complete = false;
    for await (const event of response.stream ?? []) {
      if (event.contentBlockStart?.start?.toolUse) {
        const start = event.contentBlockStart;
        blocks.set(start.contentBlockIndex!, { toolUse: { toolUseId: start.start!.toolUse!.toolUseId!, name: start.start!.toolUse!.name!, input: '' } });
      }
      if (event.contentBlockDelta) {
        const { contentBlockIndex, delta } = event.contentBlockDelta;
        const block = blocks.get(contentBlockIndex!) ?? { text: '' };
        if (delta?.text) { block.text = (block.text ?? '') + delta.text; emit({ type: 'delta', text: delta.text }); }
        if (delta?.toolUse?.input && block.toolUse) block.toolUse.input += delta.toolUse.input;
        blocks.set(contentBlockIndex!, block);
      }
      if (event.messageStop) complete = true;
      if (event.internalServerException || event.modelStreamErrorException || event.validationException || event.throttlingException || event.serviceUnavailableException) throw new Error('Falha no streaming do modelo.');
    }
    if (!complete) throw new Error('Resposta incompleta do modelo.');
    const content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block.toolUse
      ? { toolUse: { ...block.toolUse, input: JSON.parse(block.toolUse.input || '{}') } }
      : { text: block.text || ' ' }) as ContentBlock[];
    return { role: 'assistant', content } as Message;
  },
  async invoke(userId, method, resource, body, id) {
    const event = { httpMethod: method, resource, requestContext: { authorizer: { claims: { sub: userId } } },
      ...(method === 'GET' && resource === '/catalogo' ? { queryStringParameters: body } : {}),
      body: method === 'POST' ? JSON.stringify(body) : null, pathParameters: id ? { id } : null };
    const response = await lambda.send(new InvokeCommand({ FunctionName: process.env.TOOLS_FUNCTION,
      Payload: Buffer.from(JSON.stringify(event)) }), { abortSignal: AbortSignal.timeout(25000) });
    if (response.FunctionError) throw new Error('Falha na ferramenta.');
    const output = JSON.parse(Buffer.from(response.Payload!).toString());
    const value = JSON.parse(output.body);
    if (output.statusCode >= 500) throw new Error('Ferramenta indisponível; consulte o estado antes de repetir.');
    return output.statusCode >= 400 ? { erro: 'SOLICITACAO_RECUSADA', mensagem: value.message } : value;
  },
};

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/ping') { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"Healthy"}'); return; }
  if (req.method !== 'POST' || req.url !== '/invocations') { res.writeHead(404).end(); return; }
  let body = '';
  try {
    for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 350000) throw new Error('Histórico excede o limite.'); }
    const input = JSON.parse(body);
    if (typeof input.userId !== 'string' || !input.userId.trim() || !Array.isArray(input.messages)) throw new Error('Contexto inválido.');
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    res.write(JSON.stringify({ type: 'status', message: 'Preparando resposta…' }) + '\n');
    await runAgent(input, auditTools(dependencies), event => res.write(JSON.stringify(event) + '\n'));
  } catch (error) {
    const failure = error as { name?: string; message?: string; $metadata?: { requestId?: string; httpStatusCode?: number } };
    console.error('Falha no runtime', { errorType: failure?.name, requestId: failure?.$metadata?.requestId,
      status: failure?.$metadata?.httpStatusCode,
      detail: ['AccessDeniedException', 'ValidationException', 'ResourceNotFoundException'].includes(failure?.name ?? '') ? failure.message : undefined });
    if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ type: 'error', code: failure?.name === 'ResourceNotFoundException' && /use case details/i.test(failure.message ?? '') ? 'MODEL_ACCESS_PENDING' : 'AGENT_ERROR', message: 'Não foi possível concluir. Consulte compras antes de repetir uma confirmação.' }) + '\n');
  } finally { res.end(); }
}).listen(8080, '0.0.0.0');
