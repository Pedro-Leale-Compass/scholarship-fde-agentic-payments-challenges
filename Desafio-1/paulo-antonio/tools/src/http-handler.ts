import { BadArgs, createPaymentTools } from './payments.ts';
import type { PaymentStore } from './payments.ts';

type Store = PaymentStore & {
  ensureUser(userId: string): Promise<void>;
  getAccount(userId: string): Promise<unknown>;
  getIntent(userId: string, id: string): Promise<unknown>;
};
type Event = { httpMethod: string; resource: string; body?: string | null; isBase64Encoded?: boolean;
  requestContext?: { authorizer?: { claims?: { sub?: unknown } } }; pathParameters?: { id?: string } | null;
  queryStringParameters?: { categoria?: string } | null };

export function createHttpHandler(store: Store, origin: string) {
  const tools = createPaymentTools(store);
  return async (event: Event) => {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    const reply = (statusCode: number, body: unknown) => ({ statusCode, headers, body: JSON.stringify(body) });
    // Only claims provided by the API Gateway authorizer. Never parse a body/header JWT.
    const userId = event.requestContext?.authorizer?.claims?.sub;
    if (typeof userId !== 'string' || !userId.trim() || userId !== userId.trim()) return reply(401, { message: 'Autenticação necessária.' });
    const route = `${event.httpMethod} ${event.resource}`;
    try {
      if (route === 'GET /catalogo') return reply(200, tools.listar_catalogo({ categoria: event.queryStringParameters?.categoria }));
      if (route === 'GET /conta') {
        await store.ensureUser(userId);
        return reply(200, await store.getAccount(userId));
      }
      if (route === 'GET /intencoes/{id}') {
        const id = event.pathParameters?.id;
        if (!id || id.length > 100) return reply(404, { message: 'Intenção indisponível.' });
        const intent = await store.getIntent(userId, id);
        return intent ? reply(200, intent) : reply(404, { message: 'Intenção indisponível.' });
      }
      if (route !== 'POST /intencoes' && route !== 'POST /compras') return reply(404, { message: 'Rota não encontrada.' });
      if (event.isBase64Encoded || !event.body || Buffer.byteLength(event.body) > 8192) return reply(400, { message: 'Corpo da solicitação inválido.' });
      let input: unknown;
      try { input = JSON.parse(event.body); } catch { return reply(400, { message: 'JSON inválido.' }); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return reply(400, { message: 'Argumentos inválidos.' });
      const args = input as Record<string, unknown>;
      if (route === 'POST /intencoes') {
        await store.ensureUser(userId);
        return reply(201, await tools.registrar_intencao({ sku: args.sku, quantidade: args.quantidade }, { usuario_id: userId }));
      }
      return reply(200, await tools.realizar_compra({ intencao_id: args.intencao_id, metodo_pagamento: args.metodo_pagamento }, { usuario_id: userId }));
    } catch (error) {
      if (error instanceof BadArgs) return reply(400, { message: error.message });
      // No body, token or raw SDK error in logs/responses.
      console.error('Falha na operação de pagamentos', { route, errorType: error instanceof Error ? error.name : 'Unknown' });
      return reply(503, { message: 'Serviço temporariamente indisponível. Consulte o estado da intenção antes de tentar pagar novamente.' });
    }
  };
}
