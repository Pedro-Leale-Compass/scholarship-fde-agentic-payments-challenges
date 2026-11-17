'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';

import type { ChatMessage, RuntimeConfig } from '@/lib/chat';

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null);
  return body?.error || body?.message || `HTTP ${response.status}`;
}

export function useChat(config: RuntimeConfig) {
  const [token, setToken] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);

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

  const reset = useCallback(() => {
    setMessages([]);
    setToken(null);
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
        const reply = data.reply || data.message || '(resposta vazia do modelo)';
        setMessages([...history, { role: 'assistant', content: reply }]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setMessages([...history, { role: 'assistant', content: `Erro: ${message}` }]);
      } finally {
        setLoading(false);
      }
    },
    [config.apiUrl, loading, messages, token],
  );

  return { token, messages, loading, send, reset };
}
