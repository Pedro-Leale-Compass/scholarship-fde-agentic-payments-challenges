import { useCallback, useEffect, useState } from 'react'
import { Authenticator, ThemeProvider, defaultDarkModeOverride, translations, type Theme } from '@aws-amplify/ui-react'
import { I18n } from 'aws-amplify/utils'
import type { ConfigApp } from './config.ts'
import Chat from './components/Chat.tsx'
import ListaConversas from './components/ListaConversas.tsx'

I18n.putVocabularies(translations)
I18n.putVocabulariesForLanguage('pt', {
  Email: 'E-mail',
  'Enter your Email': 'Digite seu e-mail',
  'Enter your email': 'Digite seu e-mail',
  'Enter your Password': 'Digite sua senha',
  'Reset Password': 'Redefinir senha',
  'Reset your password': 'Redefinir sua senha',
  'Send code': 'Enviar código',
  'Back to Sign In': 'Voltar para o login',
  'Change Password': 'Definir nova senha',
  'New password': 'Nova senha',
  'Confirm Password': 'Confirme a senha',
})
I18n.setLanguage('pt')

const TEMA: Theme = { name: 'agente-pagamentos', overrides: [defaultDarkModeOverride] }

function IconeCarrinho({ tamanho = 20 }: { tamanho?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={tamanho}
      height={tamanho}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="9" cy="20" r="1.5" />
      <circle cx="18" cy="20" r="1.5" />
      <path d="M2 3h3l2.7 12.4a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.6L21 7H6" />
    </svg>
  )
}

const COMPONENTES_LOGIN = {
  Header() {
    return (
      <div className="login-cabecalho">
        <IconeCarrinho tamanho={40} />
        <h1>Bem-vindo ao seu assistente de compras!</h1>
        <p>Faça seu login para dar início.</p>
      </div>
    )
  },
}

type ConversaAberta = { id: string; nova: boolean }

function createConversaNova(): ConversaAberta {
  return { id: crypto.randomUUID(), nova: true }
}

type AreaLogadaProps = {
  config: ConfigApp
  email?: string
  onSair: () => void
}

export function getInicial(email?: string): string {
  const letra = email?.trim().charAt(0)
  return letra ? letra.toLocaleUpperCase('pt-BR') : '?'
}

function IconeSeta({ aberta }: { aberta: boolean }) {
  return (
    <svg
      className={aberta ? 'seta seta-aberta' : 'seta'}
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

function IconeMais() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function AreaLogada({ config, email, onSair }: AreaLogadaProps) {
  const [conversa, setConversa] = useState<ConversaAberta>(createConversaNova)
  const [atualizacao, setAtualizacao] = useState(0)
  const [listaAberta, setListaAberta] = useState(false)

  const handleTurnoFinalizado = useCallback(() => setAtualizacao((valor) => valor + 1), [])
  const handleSessaoExpirada = useCallback(() => onSair(), [onSair])

  useEffect(() => {
    if (!listaAberta) return
    const handleTecla = (evento: KeyboardEvent) => {
      if (evento.key === 'Escape') setListaAberta(false)
    }
    window.addEventListener('keydown', handleTecla)
    return () => window.removeEventListener('keydown', handleTecla)
  }, [listaAberta])

  function selectConversa(id: string): void {
    setConversa({ id, nova: false })
    setListaAberta(false)
  }

  function createNova(): void {
    setConversa(createConversaNova())
    setListaAberta(false)
  }

  return (
    <div className="app">
      <header className="topo">
        <h1>
          <IconeCarrinho />
          Agente de Pagamentos
        </h1>
        <div className="topo-usuario">
          <button
            type="button"
            className="botao-icone so-mobile"
            aria-label="Conversas anteriores"
            aria-expanded={listaAberta}
            aria-controls="painel-conversas"
            onClick={() => setListaAberta((aberta) => !aberta)}
          >
            <IconeSeta aberta={listaAberta} />
          </button>
          <button type="button" className="botao-icone so-mobile" aria-label="Nova conversa" onClick={createNova}>
            <IconeMais />
          </button>
          <span className="avatar" role="img" title={email} aria-label={email ? `Usuário: ${email}` : 'Usuário'}>
            {getInicial(email)}
          </span>
          <button type="button" className="botao-sair" onClick={onSair}>
            Sair
          </button>
        </div>
      </header>

      <div className="corpo">
        <div id="painel-conversas" className={listaAberta ? 'painel-conversas aberto' : 'painel-conversas'}>
          <ListaConversas
            config={config}
            conversaAtual={conversa.id}
            atualizacao={atualizacao}
            onSelect={selectConversa}
            onNova={createNova}
          />
        </div>
        <Chat
          key={conversa.id}
          config={config}
          conversaId={conversa.id}
          nova={conversa.nova}
          onTurnoFinalizado={handleTurnoFinalizado}
          onSessaoExpirada={handleSessaoExpirada}
        />
      </div>
    </div>
  )
}

export default function App({ config }: { config: ConfigApp }) {
  return (
    <ThemeProvider theme={TEMA} colorMode="system">
      <Authenticator hideSignUp components={COMPONENTES_LOGIN}>
        {({ signOut, user }) => (
          <AreaLogada config={config} email={user?.signInDetails?.loginId} onSair={() => signOut?.()} />
        )}
      </Authenticator>
    </ThemeProvider>
  )
}
