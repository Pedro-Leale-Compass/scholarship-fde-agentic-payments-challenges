import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import {
  ArrowRight,
  Eye,
  EyeOff,
  LockKeyhole,
  UserRound,
} from 'lucide-react'
import hero from '../assets/images/login-hero-placeholder.svg'
import { Brand } from '../components/ui/Brand'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Spinner } from '../components/ui/Spinner'
import { useAuth } from '../hooks/useAuth'
import { NewPasswordRequiredError } from '../services/authService'
import { brand } from '../config/brand'

interface PasswordChallengeState {
  username: string
  session: string
}

const PASSWORD_POLICY_MESSAGE =
  'A nova senha deve ter no mínimo 8 caracteres, com letra minúscula e número.'

export function LoginPage() {
  const { login, completeNewPassword, isAuthenticated, isLoading } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [challenge, setChallenge] = useState<PasswordChallengeState | null>(null)
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  if (isAuthenticated) return <Navigate to="/chat" replace />
  if (isLoading)
    return (
      <div className="full-loading">
        <Brand />
        <Spinner label="Verificando sessão" />
      </div>
    )
  const resetToLogin = () => {
    setChallenge(null)
    setPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setVisible(false)
    setError('')
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (challenge) {
      if (!newPassword || !confirmPassword) {
        setError('Preencha e confirme sua nova senha para continuar.')
        return
      }
      if (newPassword !== confirmPassword) {
        setError('As senhas digitadas não coincidem.')
        return
      }
      if (newPassword.length < 8 || !/[a-z]/.test(newPassword) || !/\d/.test(newPassword)) {
        setError(PASSWORD_POLICY_MESSAGE)
        return
      }
      setError('')
      setSubmitting(true)
      try {
        await completeNewPassword({
          username: challenge.username,
          newPassword,
          session: challenge.session,
        })
        setNewPassword('')
        setConfirmPassword('')
        setChallenge(null)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Não foi possível atualizar a senha.')
      } finally {
        setSubmitting(false)
      }
      return
    }
    if (!username.trim() || !password.trim()) {
      setError('Preencha seu usuário e sua senha para continuar.')
      return
    }
    setError('')
    setSubmitting(true)
    try {
      await login({ username: username.trim(), password })
      setPassword('')
    } catch (cause) {
      if (cause instanceof NewPasswordRequiredError) {
        setChallenge({ username: cause.username, session: cause.session })
        setPassword('')
        setNewPassword('')
        setConfirmPassword('')
        setVisible(false)
        setError('')
      } else {
        setError(cause instanceof Error ? cause.message : 'Não foi possível entrar.')
      }
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <main className="login-page">
      <section className="login-hero" aria-label={`Bem-vindo à ${brand.displayName}`}>
        <div className="hero-top">
          <Brand />
        </div>
        <div className="hero-copy">
          <h1>
            O próximo nível
            <br />
            das suas compras
            <br />
            <span>começa aqui.</span>
          </h1>
          <p>
            Projeto Compass UOL
            <br className="desktop-break" /> Trilha AWS AI FDE
          </p>
        </div>
        <img
          className="hero-art"
          src={hero}
          alt="Arte original de um controle gamer preto, com detalhes laranja e órbitas geométricas"
        />
        <div className="hero-art-label">
          <span className="tiny-cross">+</span>
          <span>
            FEITO PARA VOCÊ
            <br />
            <strong>FELLOWSHIP</strong>
          </span>
          <span className="art-line" />
        </div>
        <div className="hero-corner" aria-hidden="true" />
      </section>
      <section className="login-side">
        <div className="login-content animate-in">
          <div className="login-heading">
            <span className="eyebrow">
              {challenge ? 'PRIMEIRO ACESSO · COGNITO' : `BEM-VINDO À ${brand.name}`}
            </span>
            <h2>
              {challenge ? 'Defina sua senha' : 'Entre no jogo'}
              <span>.</span>
            </h2>
            <p>
              {challenge
                ? 'Sua conta foi criada com senha temporária. Crie uma senha pessoal (mín. 8 caracteres, letra minúscula e número).'
                : 'Catálogo inteligente de periféricos e pagamentos instantâneos com aprovação em tempo real.'}
            </p>
          </div>
          <form onSubmit={submit} noValidate aria-busy={submitting}>
            {challenge ? (
              <>
                <Input
                  id="new-password"
                  label="Nova senha"
                  icon={<LockKeyhole size={17} />}
                  placeholder="Mín. 8 caracteres, minúscula e número"
                  type={visible ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={newPassword}
                  disabled={submitting}
                  onChange={(e) => setNewPassword(e.target.value)}
                  aria-invalid={!!error}
                  aria-describedby={error ? 'login-error' : undefined}
                  suffix={
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={visible ? 'Ocultar senha' : 'Mostrar senha'}
                      aria-pressed={visible}
                      onClick={() => setVisible(!visible)}
                    >
                      {visible ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  }
                />
                <Input
                  id="confirm-password"
                  label="Confirmar nova senha"
                  icon={<LockKeyhole size={17} />}
                  placeholder="Repita a nova senha"
                  type={visible ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={confirmPassword}
                  disabled={submitting}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  aria-invalid={!!error}
                  aria-describedby={error ? 'login-error' : undefined}
                />
              </>
            ) : (
              <>
                <Input
                  id="username"
                  label="Usuário ou e-mail"
                  icon={<UserRound size={17} />}
                  placeholder="Seu usuário ou e-mail"
                  autoComplete="username"
                  value={username}
                  disabled={submitting}
                  onChange={(e) => setUsername(e.target.value)}
                  aria-invalid={!!error}
                  aria-describedby={error ? 'login-error' : undefined}
                />
                <Input
                  id="password"
                  label="Senha"
                  icon={<LockKeyhole size={17} />}
                  placeholder="Sua senha"
                  type={visible ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  disabled={submitting}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={!!error}
                  aria-describedby={error ? 'login-error' : undefined}
                  suffix={
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={visible ? 'Ocultar senha' : 'Mostrar senha'}
                      aria-pressed={visible}
                      onClick={() => setVisible(!visible)}
                    >
                      {visible ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  }
                />
              </>
            )}
            {error && (
              <p id="login-error" className="inline-error" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" className="login-submit" loading={submitting}>
              {challenge
                ? submitting
                  ? 'ATUALIZANDO...'
                  : 'SALVAR NOVA SENHA E ENTRAR'
                : submitting
                  ? 'ENTRANDO...'
                  : `ENTRAR NA ${brand.name}`}
              {!submitting && <ArrowRight size={19} />}
            </Button>
            {challenge && (
              <Button
                type="button"
                variant="ghost"
                className="login-submit"
                disabled={submitting}
                onClick={resetToLogin}
              >
                VOLTAR AO LOGIN
              </Button>
            )}
          </form>
        </div>
        <footer className="login-footer">
          <span>
            © {new Date().getFullYear()} {brand.name} {brand.suffix}
          </span>
        </footer>
      </section>
    </main>
  )
}
