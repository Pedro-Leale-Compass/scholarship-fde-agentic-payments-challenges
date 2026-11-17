import { Amplify } from "aws-amplify";
import { confirmSignIn, fetchAuthSession, getCurrentUser, signIn, signOut } from "aws-amplify/auth";

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_USER_POOL_ID,
      userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID,
      loginWith: { email: true },
    },
  },
});

export type ResultadoLogin = "ok" | "nova-senha";

export async function entrar(email: string, senha: string): Promise<ResultadoLogin> {
  try {
    const { isSignedIn, nextStep } = await signIn({ username: email, password: senha });
    if (isSignedIn) return "ok";
    if (nextStep.signInStep === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED") return "nova-senha";
    throw new Error(`Etapa de login nao suportada: ${nextStep.signInStep}`);
  } catch (erro: unknown) {
    if ((erro as { name?: string }).name === "UserAlreadyAuthenticatedException") return "ok";
    throw erro;
  }
}

export async function definirNovaSenha(novaSenha: string): Promise<void> {
  const { isSignedIn } = await confirmSignIn({ challengeResponse: novaSenha });
  if (!isSignedIn) throw new Error("Nao foi possivel concluir o login.");
}

export async function usuarioAtual(): Promise<string | null> {
  try {
    const usuario = await getCurrentUser();
    return usuario.signInDetails?.loginId ?? usuario.username;
  } catch {
    return null;
  }
}

export async function lerToken(): Promise<string> {
  const sessao = await fetchAuthSession();
  const token = sessao.tokens?.idToken?.toString();
  if (!token) throw new Error("Sessao expirada. Entre novamente.");
  return token;
}

export async function sair(): Promise<void> {
  await signOut();
}