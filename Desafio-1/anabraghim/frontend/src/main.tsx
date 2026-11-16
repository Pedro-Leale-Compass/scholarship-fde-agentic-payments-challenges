import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Amplify } from "aws-amplify"
import { I18n } from "aws-amplify/utils"
import { translations } from "@aws-amplify/ui-react"
import "@aws-amplify/ui-react/styles.css"
import "./index.css"
import App from "./App.tsx"
import { carregarConfig } from "./lib/config"

const raiz = createRoot(document.getElementById("root")!)

async function iniciar() {
    try {
        const config = await carregarConfig()
        Amplify.configure({
            Auth: {
                Cognito: {
                    userPoolId: config.userPoolId,
                    userPoolClientId: config.userPoolClientId,
                    loginWith: { email: true },
                },
            },
        })
        I18n.putVocabularies(translations)
        I18n.setLanguage("pt")
        raiz.render(
            <StrictMode>
                <App />
            </StrictMode>
        )
    } catch (erro) {
        console.error("Falha ao carregar a configuração", erro)
        raiz.render(
            <main className="erro-config">
                <h1>Não foi possível iniciar o aplicativo</h1>
                <p>A configuração do site não foi encontrada. Tente recarregar a página em instantes.</p>
            </main>
        )
    }
}

iniciar()
