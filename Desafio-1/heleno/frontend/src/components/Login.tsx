
import { useState, type FormEvent } from "react";
import type { CognitoUser } from "amazon-cognito-identity-js";
import {
  login,
  completeNewPassword,
  type LoginResult,
} from "../services/auth";

type LoginProps = {
  onLoginSuccess: () => void;
};

export default function Login({ onLoginSuccess }: LoginProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [pendingUser, setPendingUser] = useState<CognitoUser | null>(null);
  const [attributes, setAttributes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result: LoginResult = await login(email, password);

      if (result.status === "NEW_PASSWORD_REQUIRED") {
        setPendingUser(result.user);
        setAttributes(result.attributes);
        setPassword("");
        return;
      }

      onLoginSuccess();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Não foi possível realizar o login."
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleNewPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!pendingUser) return;

    setError("");
    setLoading(true);

    try {
      await completeNewPassword(
        pendingUser,
        newPassword,
        attributes
      );

      setNewPassword("");
      setPendingUser(null);
      onLoginSuccess();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Não foi possível definir a nova senha."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <h1>Agentic Payments</h1>
        <p>Assistente de compras com inteligência artificial</p>

        {pendingUser ? (
          <form onSubmit={handleNewPassword}>
            <h2>Definir nova senha</h2>
            <p>
              Este é seu primeiro acesso. Crie uma senha definitiva
              para continuar.
            </p>

            <label htmlFor="new-password">Nova senha</label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              required
              minLength={8}
            />

            {error && <p role="alert">{error}</p>}

            <button type="submit" disabled={loading}>
              {loading ? "Salvando..." : "Definir senha e entrar"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleLogin}>
            <h2>Entrar</h2>

            <label htmlFor="email">E-mail</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />

            <label htmlFor="password">Senha</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />

            {error && <p role="alert">{error}</p>}

            <button type="submit" disabled={loading}>
              {loading ? "Autenticando..." : "Entrar"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
