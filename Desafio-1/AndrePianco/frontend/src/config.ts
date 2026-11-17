import { Amplify } from "aws-amplify";

/**
 * Configuracao vinda de variaveis do Vite (frontend/.env.local, gerado por
 * scripts/configurar-frontend.ps1 a partir das saidas do CDK). Nenhum desses
 * valores e segredo: user pool id, client id publico e URL da API.
 */
function exigir(nome: string, valor: string | undefined): string {
  if (!valor) throw new Error(`Configuracao ausente: ${nome}. Rode scripts/configurar-frontend.ps1.`);
  return valor;
}

export const config = {
  userPoolId: exigir("VITE_USER_POOL_ID", import.meta.env.VITE_USER_POOL_ID),
  userPoolClientId: exigir("VITE_USER_POOL_CLIENT_ID", import.meta.env.VITE_USER_POOL_CLIENT_ID),
  apiUrl: exigir("VITE_API_URL", import.meta.env.VITE_API_URL).replace(/\/+$/, ""),
};

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: config.userPoolId,
      userPoolClientId: config.userPoolClientId,
      loginWith: { email: true },
    },
  },
});
