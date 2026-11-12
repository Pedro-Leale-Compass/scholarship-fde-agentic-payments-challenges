'use client';

import { Authenticator, useAuthenticator } from '@aws-amplify/ui-react';
import { useState } from 'react';
import '@aws-amplify/ui-react/styles.css';
import { Amplify } from 'aws-amplify';
import outputs from '@/amplify_outputs.json';

Amplify.configure(outputs);

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4566';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export default function Page() {
  const { user, signOut } = useAuthenticator();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  async function sendMessage() {
    if (!input.trim()) return;

    const userMessage: ChatMessage = { role: 'user', content: input };
    setMessages([...messages, userMessage]);
    setInput('');
    setLoading(true);

    try {
      const token = (user as any)?.signInUserSession?.accessToken?.jwtToken;
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

  const chatContent = (
    <div style={{ padding: '2rem', maxWidth: 800, margin: '0 auto' }}>
      <h1>Agente de Pagamentos</h1>
      <p>Bem-vindo, {user?.username}</p>

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

      <button
        onClick={signOut}
        style={{
          marginTop: '1rem',
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
  );

  return (
    <Authenticator
      formFields={{
        signUp: {
          email: { type: 'email', label: 'E-mail', required: true },
          password: { type: 'password', label: 'Senha', required: true },
        },
        signIn: {
          email: { type: 'email', label: 'E-mail', required: true },
          password: { type: 'password', label: 'Senha', required: true },
        },
      }}
    >
      {({ user: authUser, signOut: signOutFn }) => (
        <div>
          {authUser ? chatContent : null}
        </div>
      )}
    </Authenticator>
  );
}
