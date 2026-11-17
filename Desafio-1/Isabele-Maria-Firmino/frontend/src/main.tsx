import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@aws-amplify/ui-react/styles.css'
import './estilos.css'
import App from './App.tsx'
import { ConfigInvalida, configureAmplify, getConfig } from './config.ts'

function ErroConfig({ mensagem }: { mensagem: string }) {
  return (
    <main className="erro-config">
      <h1>Não foi possível iniciar o site</h1>
      <p>{mensagem}</p>
      <p>Veja a seção "Como rodar o frontend" no README.</p>
    </main>
  )
}

async function startApp(): Promise<void> {
  const elemento = document.getElementById('root')
  if (!elemento) throw new Error('elemento #root não encontrado no index.html')
  const raiz = createRoot(elemento)

  try {
    const config = await getConfig()
    configureAmplify(config)
    raiz.render(
      <StrictMode>
        <App config={config} />
      </StrictMode>,
    )
  } catch (erro) {
    console.error(erro)
    const mensagem = erro instanceof ConfigInvalida ? erro.message : 'Erro inesperado ao carregar a configuração.'
    raiz.render(
      <StrictMode>
        <ErroConfig mensagem={mensagem} />
      </StrictMode>,
    )
  }
}

void startApp()
