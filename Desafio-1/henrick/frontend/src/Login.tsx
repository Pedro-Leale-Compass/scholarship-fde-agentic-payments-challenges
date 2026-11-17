import { FormEvent, useState } from "react";
import { definirNovaSenha, entrar } from "./auth.js";

interface Props {
  aoEntrar: (email: string) => void;
}

function mensagemDeErro(erro: unknown): string {
  const nome = (erro as { name?: string }).name;
  if (nome === "NotAuthorizedException" || nome === "UserNotFoundException") {
    return "E-mail ou senha invalidos. Tente novamente.";
  }
  if (nome === "InvalidPasswordException") {
    return "A nova senha precisa de 8+ caracteres, com maiuscula, minuscula, numero e simbolo.";
  }
  return (erro as { message?: string }).message ?? "Erro ao entrar.";
}

export default function Login({ aoEntrar }: Props) {
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [novaSenha, setNovaSenha] = useState("");
  const [etapa, setEtapa] = useState<"login" | "nova-senha">("login");
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (carregando) return;
    setErro(null);
    setCarregando(true);
    try {
      if (etapa === "login") {
        const resultado = await entrar(email.trim(), senha);
        if (resultado === "nova-senha") {
          setEtapa("nova-senha");
          return;
        }
      } else {
        await definirNovaSenha(novaSenha);
      }
      aoEntrar(email.trim());
    } catch (err: unknown) {
      setErro(mensagemDeErro(err));
    } finally {
      setCarregando(false);
    }
  }

  const podeEnviar = etapa === "login" ? email.trim() && senha : novaSenha;

  return (
    <div className="login-page">
      <main className="login-card" role="main">
        <div className="login-logo">
          <div className="login-logo-icon" aria-hidden="true">🤖</div>
          <span className="login-logo-text">Agente de Pagamentos</span>
        </div>
        <p className="login-subtitle">
          {etapa === "login" ? "Entre com o e-mail do seu convite" : "Primeiro acesso: crie a sua senha definitiva"}
        </p>

        <form className="login-form" onSubmit={handleSubmit} noValidate>
          {etapa === "login" ? (
            <>
              <div className="field">
                <label htmlFor="login-email">E-mail</label>
                <input
                  id="login-email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  disabled={carregando}
                />
              </div>
              <div className="field">
                <label htmlFor="login-senha">Senha</label>
                <input
                  id="login-senha"
                  type="password"
                  autoComplete="current-password"
                  value={senha}
                  onChange={e => setSenha(e.target.value)}
                  disabled={carregando}
                />
              </div>
            </>
          ) : (
            <div className="field">
              <label htmlFor="login-nova-senha">Nova senha</label>
              <input
                id="login-nova-senha"
                type="password"
                autoComplete="new-password"
                value={novaSenha}
                onChange={e => setNovaSenha(e.target.value)}
                disabled={carregando}
              />
            </div>
          )}

          {erro && (
            <div className="login-error" role="alert" aria-live="assertive">
              <span aria-hidden="true">⚠️</span>
              {erro}
            </div>
          )}

          <button type="submit" className="btn-primary" disabled={carregando || !podeEnviar}>
            {carregando ? <><div className="spinner" aria-hidden="true" /> Entrando…</> : "Entrar →"}
          </button>
        </form>
      </main>
    </div>
  );
}