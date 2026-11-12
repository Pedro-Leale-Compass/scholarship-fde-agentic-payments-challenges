/**
 * API Lambda local — Desafio 1 (luiz-henrique).
 *
 * Executa localmente para desenvolvimento, sem AWS.
 * Invoca o container AgentCore local (localhost:3000) em vez do AgentCore Runtime da AWS.
 *
 * Uso:
 *   export LOCAL_DEV=true AWS_PROFILE=local
 *   npx tsx local/index.ts
 *
 * Endpoint:
 *   POST /chat  —  Body: { messages: [...] }  Header: Authorization: Bearer <JWT>
 */

import { createServer } from 'http';
import { URL } from 'url';

const PORT = Number(process.env.LOCAL_API_PORT) || 3032;
const AGENT_CORE_URL = process.env.AGENT_CORE_URL || 'http://localhost:3031/invocations';
const IS_LOCAL = process.env.LOCAL_DEV === 'true' || process.env.AWS_PROFILE === 'local';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: Array<{ text: string }>;
}

interface ChatEventBody {
  messages?: ChatMessage[];
}

function extractUsuarioId(headers: Record<string, string> | undefined): string | null {
  const auth = headers?.Authorization || headers?.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const payloadPart = token.split('.')[1];
    if (!payloadPart) return null;
    const decoded = Buffer.from(
      payloadPart.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    );
    const payload = JSON.parse(decoded.toString('utf-8'));
    return payload.sub || null;
  } catch (_) {
    return null;
  }
}

function makeJwt(usuario_id: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const payload = Buffer.from(JSON.stringify({ sub: usuario_id }))
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${header}.${payload}.`;
}

async function invokeAgentCore(
  usuario_id: string,
  messages: ChatMessage[],
): Promise<{ ok: boolean; reply: string; error?: string }> {
  const prompt = messages
    .map((m) => `${m.role}: ${m.content.map((c) => c.text).join(' ')}`)
    .join('\n');

  try {
    const response = await fetch(AGENT_CORE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-amzn-bedrock-agentcore-runtime-session-id': `local-${usuario_id}`,
      },
      body: JSON.stringify({
        prompt,
        usuario_id,
        messages,
      }),
    });

    if (!response.ok) {
      return { ok: false, reply: '', error: `AgentCore ${response.status}` };
    }

    const data = (await response.json()) as { reply?: string; message?: string };
    return {
      ok: true,
      reply: data.reply || data.message || 'Sem resposta',
    };
  } catch (err) {
    return {
      ok: false,
      reply: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const server = createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  // Health check
  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, service: 'local-api' }));
    return;
  }

  // Mock JWT endpoint (for frontend testing)
  if (url.pathname === '/auth/token' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req as any) {
      body += chunk;
    }
    try {
      const { usuario_id = 'usuario-teste' } = JSON.parse(body || '{}');
      const token = makeJwt(usuario_id);
      res.writeHead(200);
      res.end(JSON.stringify({ accessToken: { jwtToken: token }, usuario_id }));
    } catch (_) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'invalid request' }));
    }
    return;
  }

  // Chat endpoint
  if (url.pathname === '/chat' && req.method === 'POST') {
    const headers = req.headers as Record<string, string>;
    const usuario_id = extractUsuarioId(headers);

    if (!usuario_id) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'missing or invalid token' }));
      return;
    }

    let body: ChatEventBody = {};
    let rawBody = '';
    for await (const chunk of req as any) {
      rawBody += chunk as string;
    }
    try {
      body = JSON.parse(rawBody || '{}');
    } catch (_) {
      body = {};
    }

    const messages = body.messages || [];

    const result = await invokeAgentCore(usuario_id, messages);

    if (!result.ok) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: result.error }));
      return;
    }

    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, usuario_id, reply: result.reply }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Local API listening on http://0.0.0.0:${PORT}`);
  console.log(`AgentCore URL: ${AGENT_CORE_URL}`);
  console.log(`Mock token: POST http://localhost:${PORT}/auth/token`);
  console.log(`Chat: POST http://localhost:${PORT}/chat`);
});
