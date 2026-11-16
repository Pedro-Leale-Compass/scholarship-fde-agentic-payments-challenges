import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"

// Em produção, o CloudFront serve o site e encaminha /api/* para o API Gateway
// (mesma origem, sem CORS). Em desenvolvimento, o Vite faz o mesmo papel: com
// API_URL=<Output ApiUrl, ex.: https://abc.execute-api.us-east-1.amazonaws.com/prod>
// em frontend/.env.local, /api/* é repassado para a API publicada.
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), "")
    return {
        plugins: [react()],
        server: env.API_URL ? { proxy: { "/api": { target: env.API_URL, changeOrigin: true } } } : undefined,
    }
})
