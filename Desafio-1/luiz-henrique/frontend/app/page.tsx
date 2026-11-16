'use client';

import { useEffect, useState } from 'react';
import { Amplify } from 'aws-amplify';
import { signOut, fetchAuthSession } from 'aws-amplify/auth';
import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';

interface RuntimeConfig {
  apiUrl: string;
  userPoolId: string;
  userPoolClientId: string;
  region: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export default function Page() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/config.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`config ${r.status}`))))
      .then((cfg: RuntimeConfig) => {
        Amplify.configure({
          Auth: {
            Cognito: {
              userPoolId: cfg.userPoolId,
              userPoolClientId: cfg.userPoolClientId,
            },
          },
        });
        setConfig(cfg);
      })
      .catch((err) => setConfigError(`Não foi possível carregar config.json: ${err.message}`));
  }, []);

  if (configError) {
    return <div style={{ padding: '2rem' }}>{configError}</div>;
  }

  if (!config) {
    return <div style={{ padding: '2rem' }}>Carregando...</div>;
  }

  return (
    <Authenticator>
      {({ signOut, user }) => (
        <ChatApp config={config} user={user} signOut={signOut} />
      )}
    </Authenticator>
  );
}

function ChatApp({ config, user, signOut }: { config: RuntimeConfig; user: any; signOut: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const session = await fetchAuthSession();
        const idToken = session.tokens?.idToken?.toString();
        if (idToken && mounted) {
          setToken(idToken);
        }
      } catch (_) {
        // sem sessão válida
      }
    })();
    return () => { mounted = false; };
  }, []);

  async function sendMessage() {
    if (!input.trim() || !config || !token) return;

    const userMessage: ChatMessage = { role: 'user', content: input };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);

    try {
      const response = await fetch(`${config.apiUrl}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          messages: nextMessages.map((m) => ({
            role: m.role,
            content: [{ text: m.content }],
          })),
        }),
      });

      if (response.status === 401) {
        throw new Error('401 não autorizado — faça login novamente.');
      }
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || errorData.message || `HTTP ${response.status}`);
      }

      const data = await response.json();
      setMessages([
        ...nextMessages,
        { role: 'assistant', content: data.reply || data.message || 'Sem resposta' },
      ]);
    } catch (err) {
      setMessages([
        ...nextMessages,
        { role: 'assistant', content: `Erro: ${err instanceof Error ? err.message : String(err)}` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: '2rem', maxWidth: 800, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <div>
          <h1>Agente de Pagamentos</h1>
          <p>Bem-vindo, {user?.username || user?.userId || 'usuário'}</p>
        </div>
        <button
          onClick={() => { signOut(); setToken(null); setMessages([]); }}
          style={{ padding: '0.5rem 1rem', background: '#dc2626', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
        >
          Sair
        </button>
      </div>

      <div
        style={{
          border: '1px solid #ddd',
          borderRadius: '8px',
          padding: '1rem',
          height: '400px',
          overflowY: 'auto',
          marginBottom: '1rem',
          background: '#f9f9f9',
        }}
      >
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              marginBottom: '1rem',
              padding: '0.75rem',
              borderRadius: '6px',
              background: m.role === 'user' ? '#dbeafe' : '#ffffff',
              border: '1px solid #ccc',
              whiteSpace: 'pre-wrap',
            }}
          >
            <strong>{m.role === 'user' ? 'Você' : 'Agente'}: </strong>
            {m.content}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
          placeholder="Digite sua mensagem (ex: listar produtos, comprar com cartão)"
          disabled={loading || !token}
          style={{ flex: 1, padding: '0.75rem', border: '1px solid #ccc', borderRadius: '4px', fontSize: '1rem' }}
        />
        <button
          onClick={sendMessage}
          disabled={loading || !input.trim() || !token}
          style={{ padding: '0.75rem 1.5rem', background: loading || !input.trim() || !token ? '#9ca3af' : '#2563eb', color: '#fff', border: 'none', borderRadius: '4px', cursor: loading || !input.trim() || !token ? 'not-allowed' : 'pointer', fontSize: '1rem' }}
        >
          {loading ? 'Enviando...' : 'Enviar'}
        </button>
      </div>
    </div>
  );
}
