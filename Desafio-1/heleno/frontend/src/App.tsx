
import { useEffect, useState } from "react";
import Login from "./components/Login";
import Chat from "./components/Chat";
import { getCurrentSession, logout } from "./services/auth";
import { reiniciarSessaoChat } from "./services/chat";
import "./App.css";

export default function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    async function checkSession() {
      try {
        const session = await getCurrentSession();
        setAuthenticated(session !== null);
      } catch {
        setAuthenticated(false);
      } finally {
        setCheckingSession(false);
      }
    }

    void checkSession();
  }, []);

  function handleLoginSuccess() {
    // Inicia uma nova conversa após o login.
    reiniciarSessaoChat();
    setAuthenticated(true);
  }

  function handleLogout() {
    // Encerra a autenticação local do Cognito.
    logout();

    // Gera um novo identificador para a próxima conversa.
    reiniciarSessaoChat();

    // Retorna à tela de login e desmonta o componente Chat.
    setAuthenticated(false);
  }

  if (checkingSession) {
    return (
      <main className="loading-page">
        <p>Verificando sessão...</p>
      </main>
    );
  }

  if (!authenticated) {
    return <Login onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <main className="dashboard-page">
      <header className="dashboard-header">
        <div>
          <h1>Agentic Payments</h1>
          <p>Assistente inteligente de compras</p>
        </div>

        <button type="button" onClick={handleLogout}>
          Sair
        </button>
      </header>

      <section className="dashboard-content">
        <Chat />
      </section>
    </main>
  );
}
