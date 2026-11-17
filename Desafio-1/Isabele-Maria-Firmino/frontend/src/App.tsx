import { useCallback, useState } from 'react'
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

function AreaLogada({ config, email, onSair }: AreaLogadaProps) {
  const [conversa, setConversa] = useState<ConversaAberta>(createConversaNova)
  const [atualizacao, setAtualizacao] = useState(0)

  const handleTurnoFinalizado = useCallback(() => setAtualizacao((valor) => valor + 1), [])
  const handleSessaoExpirada = useCallback(() => onSair(), [onSair])

  return (
    <div className="app">
      <header className="topo">
        <h1>
          <IconeCarrinho />
          Agente de Pagamentos
        </h1>
        <div className="topo-usuario">
          {email && <span>{email}</span>}
          <button type="button" onClick={onSair}>
            Sair
          </button>
        </div>
      </header>

      <div className="corpo">
        <ListaConversas
          config={config}
          conversaAtual={conversa.id}
          atualizacao={atualizacao}
          onSelect={(id) => setConversa({ id, nova: false })}
          onNova={() => setConversa(createConversaNova())}
        />
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
