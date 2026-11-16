import { Authenticator } from "@aws-amplify/ui-react"
import ChatPage from "./pages/ChatPage"

// Cadastro só por convite: o user pool já recusa SignUp (AllowAdminCreateUserOnly)
// e aqui a aba "Criar conta" nem aparece. O Authenticator cuida do login, da troca
// obrigatória da senha temporária do convite e do "esqueci minha senha".
const componentes = {
    Header() {
        return <div className="auth-brand">◈ assistente de compras</div>
    },
}

const campos = {
    signIn: {
        username: { label: "E-mail", placeholder: "seu e-mail" },
        password: { label: "Senha", placeholder: "sua senha" },
    },
    forceNewPassword: {
        password: { label: "Nova senha", placeholder: "mínimo 8 caracteres, com maiúscula, minúscula e número" },
    },
}

function App() {
    return (
        <Authenticator hideSignUp components={componentes} formFields={campos}>
            {({ signOut }) => <ChatPage onSair={() => signOut?.()} />}
        </Authenticator>
    )
}

export default App
