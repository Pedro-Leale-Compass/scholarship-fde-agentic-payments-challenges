import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend roda local por enquanto (orientacao do techlead); a API e o
// API Gateway na AWS, chamado direto com o JWT do Cognito -- sem proxy.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  // @desafio/shared e TypeScript cru; deixar o Vite compilar.
  optimizeDeps: { exclude: ["@desafio/shared"] },
});
