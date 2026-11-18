import { useState, useEffect, useRef } from 'react';
import { Authenticator, useAuthenticator } from '@aws-amplify/ui-react';
import { getHistory, sendMessage } from './api';
import './App.css';

function App() {
  const { authStatus, user, signOut } = useAuthenticator((ctx) => [ctx.authStatus, ctx.user]);
  const logado = authStatus === 'authenticated';
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const chatEndRef = useRef(null);

  useEffect(() => {
    if (logado) {
      getHistory()
        .then(data => setMessages(data.messages || []))
        .catch(() => setMessages([]));
    }
  }, [logado]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (e) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userMsg = input;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setLoading(true);

    try {
      // A resposta chega aos poucos: cria a bolha do agente e vai completando o texto.
      let primeiro = true;
      await sendMessage(userMsg, (pedaco) => {
        if (primeiro) {
          primeiro = false;
          setLoading(false);
          setMessages(prev => [...prev, { role: 'assistant', content: pedaco }]);
        } else {
          setMessages(prev => {
            const copia = [...prev];
            const ultima = copia[copia.length - 1];
            copia[copia.length - 1] = { ...ultima, content: ultima.content + pedaco };
            return copia;
          });
        }
      });
    } catch (error) {
      setMessages(prev => [...prev, { role: 'assistant', content: error.message || 'Erro ao falar com o assistente.' }]);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    setMessages([]);
    signOut();
  };

  // Exibe respostas do modelo como texto simples, sem marcas de Markdown.
  const formatMessage = (text) => {
    if (!text) return "";
    return text
      .replace(/&#x20;|&#32;|&nbsp;/gi, ' ')
      .replace(/\\([_*`])/g, '$1')
      .replace(/\*\*/g, '')
      .replace(/`/g, '');
  };

  if (!logado) {
    return (
      <main className="login-page">
        <section className="login-container">
          <div className="brand-mark" aria-hidden="true">🛒</div>
          <p className="eyebrow">CHATPAY · PAGAMENTOS COM MCP</p>
          <h1>Seu assistente de compras</h1>
          <p className="login-copy">
            Consulte o catálogo e acompanhe suas compras com segurança.
          </p>

          {/* Login do Cognito; sem opção de cadastro: usuários só entram por convite. */}
          <Authenticator
            hideSignUp
            formFields={{ signIn: { username: { label: "E-mail", placeholder: "Digite seu e-mail" } } }}
          />
          <p className="local-note">Acesso somente por convite do administrador</p>
        </section>
      </main>
    );
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
            <span className="session-label">{user?.signInDetails?.loginId || 'Sessão protegida'}</span>
            <button className="logout-button" onClick={handleLogout}>Sair</button>
          </div>
        </header>

        <div className="messages">
          {messages.length === 0 && (
            <div className="empty-state">
              <div className="empty-icon" aria-hidden="true">✦</div>
              <h3>Como posso ajudar?</h3>
              <p>Peça o catálogo, escolha um produto ou acompanhe uma compra.</p>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`message ${m.role}`}>
              <strong>{m.role === 'user' ? 'Você' : 'Agente'}</strong>
              <p>{formatMessage(m.content)}</p>
            </div>
          ))}

        {loading && (
          <div className="message assistant">
            <span className="loading-indicator"><i /><i /><i /></span>
            <em>O agente está consultando as ferramentas...</em>
          </div>
        )}
          <div ref={chatEndRef} />
        </div>

        <form className="input-area" onSubmit={handleSend}>
          <div className="compose-box">
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Escreva uma mensagem..."
              aria-label="Mensagem para o assistente"
              disabled={loading}
            />
            <button className="send-button" type="submit" disabled={loading} aria-label="Enviar mensagem">
              <span aria-hidden="true">↑</span>
            </button>
          </div>
          <span className="input-note">As compras são simuladas. Backend na AWS (Bedrock AgentCore).</span>
        </form>
      </div>
    </main>
  );
}

export default App;
