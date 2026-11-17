import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"

// Modo local: o Vite repassa /api/* para a API publicada, de servidor para
// servidor. Assim a página e a API ficam na mesma origem (localhost:5173) e não
// há CORS; no modo hospedado, o CloudFront faz esse papel. Requer
// API_URL=<Output ApiUrl, ex.: https://abc.execute-api.us-east-1.amazonaws.com/prod>
// em frontend/.env.local (lido só ao iniciar).
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), "")
    return {
        plugins: [react()],
        server: env.API_URL ? { proxy: { "/api": { target: env.API_URL, changeOrigin: true } } } : undefined,
    }
})
