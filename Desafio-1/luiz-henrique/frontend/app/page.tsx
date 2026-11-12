'use client';

import { useState } from 'react';
import {
  authenticateMock,
  decodeMockJwt,
  makeMockJwt,
  getMockUsers,
  isLocalDev,
} from '@/lib/mock-auth';

const API_URL = isLocalDev()
  ? process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3032'
  : process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4566';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface MockUser {
  email: string;
  name: string;
  sub: string;
}

export default function Page() {
  const [user, setUser] = useState<MockUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Verifica se já há um token válido no localStorage (reload da página)
  if (typeof window !== 'undefined' && !user && !token) {
    const stored = localStorage.getItem('desafio-1-token');
    if (stored) {
      const decoded = decodeMockJwt(stored);
      if (decoded?.sub) {
        const mockUser = getMockUsers().find((u) => u.sub === decoded.sub);
        if (mockUser) {
          setUser(mockUser);
          setToken(stored);
        }
      }
    }
  }

  async function handleLogin(email: string, password: string) {
    setLoginError(null);
    const user = authenticateMock(email, password);
    if (!user) {
      setLoginError('E-mail ou senha inválidos');
      return;
    }
    const jwt = makeMockJwt(user.sub, user.email);
    setUser(user);
    setToken(jwt);
    localStorage.setItem('desafio-1-token', jwt);
  }

  function handleLogout() {
    setUser(null);
    setToken(null);
    setMessages([]);
    localStorage.removeItem('desafio-1-token');
  }

  async function sendMessage() {
    if (!input.trim()) return;

    const userMessage: ChatMessage = { role: 'user', content: input };
    setMessages([...messages, userMessage]);
    setInput('');
    setLoading(true);

    try {
      const response = await fetch(`${API_URL}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          messages: [
            ...messages,
            { role: 'user', content: input },
          ].map((m) => ({
            role: m.role,
            content: [{ text: m.content }],
          })),
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const data = await response.json();
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: data.reply || data.message || 'Sem resposta',
      };
      setMessages([...messages, userMessage, assistantMessage]);
    } catch (err) {
      setMessages([
        ...messages,
        userMessage,
        {
          role: 'assistant',
          content: `Erro: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  // Página de login (quando não autenticado)
  if (!user || !token) {
    return (
      <div style={{ padding: '2rem', maxWidth: 400, margin: '0 auto' }}>
        <h1>Agente de Pagamentos</h1>
        <p>Faça login para acessar o chat</p>

        {loginError && (
          <div
            style={{
              padding: '0.75rem',
              background: '#fee2e2',
              border: '1px solid #dc2626',
              borderRadius: '4px',
              color: '#991b1b',
              marginBottom: '1rem',
              fontSize: '0.9rem',
            }}
          >
            {loginError}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData(e.target as HTMLFormElement);
            handleLogin(
              formData.get('email') as string,
              formData.get('password') as string,
            );
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
        >
          <div>
            <label style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}>
              E-mail
            </label>
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              style={{
                width: '100%',
                padding: '0.5rem',
                border: '1px solid #ccc',
                borderRadius: '4px',
                fontSize: '1rem',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}>
              Senha
            </label>
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              style={{
                width: '100%',
                padding: '0.5rem',
                border: '1px solid #ccc',
                borderRadius: '4px',
                fontSize: '1rem',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            style={{
              padding: '0.5rem 1rem',
              background: loading ? '#9ca3af' : '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: '1rem',
            }}
          >
            {loading ? 'Entrando...' : 'Entrar'}
          </button>
        </form>

        <div style={{ marginTop: '1.5rem', paddingTop: '1rem', borderTop: '1px solid #eee', fontSize: '0.85rem', color: '#666' }}>
          <p>Usuários de teste:</p>
          <ul style={{ margin: '0.5rem 0', paddingLeft: '1.2rem' }}>
            {getMockUsers().map((u) => (
              <li key={u.email}>
                {u.email} / {u.password}
              </li>
            ))}
          </ul>
          <p>
            Modo local: JWT não é verificado (apenas o <code>sub</code> é lido).
            Na AWS, o Cognito valida o token via API Gateway.
          </p>
        </div>
      </div>
    );
  }

  // Página de chat (quando autenticado)
  return (
    <div style={{ padding: '2rem', maxWidth: 800, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <div>
          <h1>Agente de Pagamentos</h1>
          <p>Bem-vindo, {user.name} ({user.email})</p>
        </div>
        <button
          onClick={handleLogout}
          style={{
            padding: '0.5rem 1rem',
            background: '#dc2626',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
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
          onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
          placeholder="Digite sua mensagem (ex: listar produtos, comprar com cartão)"
          disabled={loading}
          style={{
            flex: 1,
            padding: '0.75rem',
            border: '1px solid #ccc',
            borderRadius: '4px',
            fontSize: '1rem',
          }}
        />
        <button
          onClick={sendMessage}
          disabled={loading || !input.trim()}
          style={{
            padding: '0.75rem 1.5rem',
            background: loading ? '#9ca3af' : '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
            fontSize: '1rem',
          }}
        >
          {loading ? 'Enviando...' : 'Enviar'}
        </button>
      </div>
    </div>
  );
}
