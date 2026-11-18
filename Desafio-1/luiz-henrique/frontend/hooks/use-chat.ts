'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';

import type { ChatMessage, RuntimeConfig } from '@/lib/chat';

const CONVERSA_KEY = 'desafio1_conversa_id';

function newConversaId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `conv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getOrCreateConversaId(): string {
  if (typeof window === 'undefined') return newConversaId();
  const existing = window.localStorage.getItem(CONVERSA_KEY);
  if (existing) return existing;
  const id = newConversaId();
  window.localStorage.setItem(CONVERSA_KEY, id);
  return id;
}

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null);
  return body?.error || body?.message || `HTTP ${response.status}`;
}

export function useChat(config: RuntimeConfig) {
  const [token, setToken] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversaId, setConversaId] = useState<string>(() => getOrCreateConversaId());
  const [loading, setLoading] = useState(false);
  const historyLoadedFor = useRef<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const session = await fetchAuthSession();
        const idToken = session.tokens?.idToken?.toString();
        if (idToken && mounted) setToken(idToken);
      } catch {
        // sem sessão válida — o Authenticator trata o redirecionamento
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!token) return;
    if (historyLoadedFor.current === conversaId) return;
    historyLoadedFor.current = conversaId;
    let mounted = true;
    (async () => {
      try {
        const response = await fetch(
          `${config.apiUrl}/conversas?conversa_id=${encodeURIComponent(conversaId)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!response.ok) return;
        const data = await response.json();
        const loaded: ChatMessage[] = Array.isArray(data.messages)
          ? data.messages
              .map(
                (message: {
                  role?: unknown;
                  content?: Array<{ text?: unknown }>;
                }) => ({
                  role: message.role === 'assistant' ? 'assistant' : 'user',
                  content: Array.isArray(message.content)
                    ? message.content
                        .map((block) =>
                          typeof block.text === 'string' ? block.text : '',
                        )
                        .join(' ')
                    : '',
                }),
              )
              .filter((message: ChatMessage) => message.content.trim())
          : [];
        // Nunca sobrescreve uma mensagem recém-enviada; o GET é best-effort
        // e pode chegar depois da resposta do chat.
        if (mounted && loaded.length > 0) {
          setMessages((current) => (current.length === 0 ? loaded : current));
        }
      } catch {
        // histórico é best-effort; o chat continua funcionando
      }
    })();
    return () => {
      mounted = false;
    };
  }, [config.apiUrl, conversaId, token]);

  const reset = useCallback(() => {
    const next = newConversaId();
    window.localStorage.setItem(CONVERSA_KEY, next);
    setConversaId(next);
    setMessages([]);
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || loading || !token) return;

      const userMessage: ChatMessage = { role: 'user', content: trimmed };
      const history = [...messages, userMessage];
      setMessages([...history, { role: 'assistant', content: '' }]);
      setLoading(true);

      try {
        const response = await fetch(`${config.apiUrl}/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            conversa_id: conversaId,
            messages: history.map((message) => ({
              role: message.role,
              content: [{ text: message.content }],
            })),
          }),
        });

        if (response.status === 401) {
          throw new Error('401 não autorizado — faça login novamente.');
        }
        if (!response.ok) {
          throw new Error(await readError(response));
        }

        const data = await response.json();
        if (typeof data.conversa_id === 'string' && data.conversa_id) {
          window.localStorage.setItem(CONVERSA_KEY, data.conversa_id);
          setConversaId(data.conversa_id);
        }
        const reply = data.reply || data.message || '(resposta vazia do modelo)';
        setMessages([...history, { role: 'assistant', content: reply }]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setMessages([...history, { role: 'assistant', content: `Erro: ${message}` }]);
      } finally {
        setLoading(false);
      }
    },
    [config.apiUrl, conversaId, loading, messages, token],
  );

  return { token, messages, loading, send, reset };
}
