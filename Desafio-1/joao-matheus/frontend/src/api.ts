/**
 * Cliente HTTP para a API REST do WebChat com autenticação via Cognito.
 */

import { fetchAuthSession } from 'aws-amplify/auth';
import type { AppConfig } from './config';

export class NaoAutenticadoError extends Error {
  constructor() {
    super('Usuário não autenticado.');
    this.name = 'NaoAutenticadoError';
  }
}

export type EventoChat =
  | { tipo: 'delta'; texto: string }
  | { tipo: 'ferramenta'; nome: string }
  | { tipo: 'erro'; mensagem: string }
  | { tipo: 'fim' };

export interface MensagemHistorico {
  role: 'user' | 'assistant';
  texto: string;
  criado_em?: string | null;
}

/**
 * Obtém o ID token atualizado do Cognito através da sessão do Amplify.
 * Renova o token automaticamente caso tenha expirado.
 */
export async function obterIdToken(): Promise<string> {
  const sessao = await fetchAuthSession();
  const idToken = sessao.tokens?.idToken?.toString();
  if (!idToken) {
    throw new NaoAutenticadoError();
  }
  return idToken;
}

/**
 * Envia uma mensagem para o endpoint POST /chat e consome o stream SSE em tempo real.
 */
export async function* enviarMensagem(
  cfg: AppConfig,
  mensagem: string,
  signal?: AbortSignal
): AsyncGenerator<EventoChat> {
  const token = await obterIdToken();

  const resp = await fetch(`${cfg.apiUrl}/chat`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ mensagem }),
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new NaoAutenticadoError();
  }

  if (!resp.ok || !resp.body) {
    throw new Error('Falha na comunicação com o assistente.');
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const partes = buffer.split(/\r?\n\r?\n/);
      buffer = partes.pop() ?? '';

      for (const parte of partes) {
        for (const linha of parte.split(/\r?\n/)) {
          const limpa = linha.trim();
          if (limpa.startsWith('data:')) {
            const jsonStr = limpa.slice(5).trim();
            try {
              yield JSON.parse(jsonStr) as EventoChat;
            } catch {
              yield { tipo: 'delta', texto: jsonStr };
            }
          }
        }
      }
    }

    if (buffer.trim()) {
      for (const linha of buffer.split(/\r?\n/)) {
        const limpa = linha.trim();
        if (limpa.startsWith('data:')) {
          const jsonStr = limpa.slice(5).trim();
          try {
            yield JSON.parse(jsonStr) as EventoChat;
          } catch {
            yield { tipo: 'delta', texto: jsonStr };
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Consulta as mensagens anteriores no endpoint GET /conversas.
 */
export async function buscarConversas(cfg: AppConfig): Promise<MensagemHistorico[]> {
  const token = await obterIdToken();

  const resp = await fetch(`${cfg.apiUrl}/conversas`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new NaoAutenticadoError();
  }

  if (!resp.ok) {
    throw new Error('Não foi possível carregar o histórico de conversas.');
  }

  const data = await resp.json();
  return data.mensagens || [];
}
