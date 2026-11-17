import { useEffect, useRef, useState } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { Authenticator, useAuthenticator } from '@aws-amplify/ui-react';
import { getHistory, sendMessage } from './api';
import './App.css';

function Chat() {
  const { user, signOut } = useAuthenticator((context) => [context.user]);
  const [token, setToken] = useState('');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const chatEndRef = useRef(null);

  useEffect(() => {
    let active = true;
    async function loadConversation() {
      try {
        const session = await fetchAuthSession();
        const idToken = session.tokens?.idToken?.toString();
        if (!idToken) throw new Error('Não foi possível obter a sessão autenticada.');
        const data = await getHistory(idToken);
        if (active) {
          setToken(idToken);
          setMessages(data.messages || []);
          setError('');
        }
      } catch (requestError) {
        if (active) setError(requestError.message);
      }
    }
    loadConversation();
    return () => {
      active = false;
    };
  }, [user?.username]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function handleSend(event) {
    event.preventDefault();
    if (!input.trim() || loading || !token) return;

    const message = input.trim();
    setInput('');
    setError('');
    setMessages((current) => [
      ...current,
      { role: 'user', content: message },
      { role: 'assistant', content: '' },
    ]);
    setLoading(true);

    try {
      await sendMessage(message, token, (answer) => {
        setMessages((current) => {
          const updated = [...current];
          updated[updated.length - 1] = { role: 'assistant', content: answer };
          return updated;
        });
      });
    } catch (requestError) {
      setError(requestError.message);
      setMessages((current) => {
        const updated = [...current];
        updated[updated.length - 1] = {
          role: 'assistant',
          content: requestError.message,
        };
        return updated;
      });
    } finally {
      setLoading(false);
    }
  }

  function handleLogout() {
    setToken('');
    setMessages([]);
    signOut();
  }

  function formatMessage(text) {
    if (!text) return '';
    return text.split(/(\*\*.*?\*\*)/g).map((part, index) => (
      part.startsWith('**') && part.endsWith('**')
        ? <strong key={index}>{part.slice(2, -2)}</strong>
        : part
    ));
  }

  return (
    <main className="chat-page">
      <div className="chat-container">
        <header className="header">
          <div className="brand-lockup">
            <div className="brand-mark brand-mark-small" aria-hidden="true">🛒</div>
            <div>
              <h2>ChatPay</h2>
              <span className="status-label"><i /> Assistente online</span>
            </div>
          </div>
          <div className="header-actions">
            <span className="session-label">Sessão protegida</span>
            <button className="logout-button" onClick={handleLogout}>Sair</button>
          </div>
        </header>

        <div className="messages" aria-live="polite">
          {messages.length === 0 && !error && (
            <div className="empty-state">
              <div className="empty-icon" aria-hidden="true">✦</div>
              <h3>Como posso ajudar?</h3>
              <p>Peça o catálogo, escolha um produto ou acompanhe uma compra.</p>
            </div>
          )}

          {messages.map((message, index) => (
            <div key={`${index}-${message.role}`} className={`message ${message.role}`}>
              <strong>{message.role === 'user' ? 'Você' : 'Agente'}</strong>
              <p>{formatMessage(message.content)}</p>
            </div>
          ))}

          {loading && (
            <div className="message assistant">
              <span className="loading-indicator"><i /><i /><i /></span>
              <em>Processando ferramentas...</em>
            </div>
          )}
          {error && <p className="request-error" role="alert">{error}</p>}
          <div ref={chatEndRef} />
        </div>

        <form className="input-area" onSubmit={handleSend}>
          <div className="compose-box">
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Escreva uma mensagem..."
              aria-label="Mensagem para o assistente"
              disabled={loading || !token}
            />
            <button
              className="send-button"
              type="submit"
              disabled={loading || !token}
              aria-label="Enviar mensagem"
            >
              <span aria-hidden="true">↑</span>
            </button>
          </div>
          <span className="input-note">As compras são simuladas neste ambiente.</span>
        </form>
      </div>
    </main>
  );
}

export default function App() {
  return (
    <Authenticator hideSignUp>
      <Chat />
    </Authenticator>
  );
}
