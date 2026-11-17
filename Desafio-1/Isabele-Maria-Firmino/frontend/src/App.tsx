import { useCallback, useState } from 'react'
import { Authenticator, translations } from '@aws-amplify/ui-react'
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
        <h1>🛒 Agente de Pagamentos</h1>
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
    <Authenticator hideSignUp>
      {({ signOut, user }) => (
        <AreaLogada config={config} email={user?.signInDetails?.loginId} onSair={() => signOut?.()} />
      )}
    </Authenticator>
  )
}
