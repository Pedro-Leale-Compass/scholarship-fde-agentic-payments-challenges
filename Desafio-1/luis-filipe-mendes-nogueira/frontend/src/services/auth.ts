import { Amplify } from "aws-amplify";
import { fetchAuthSession, signOut } from "aws-amplify/auth";
import { carregarConfig } from "./config";

let configuracao: Promise<void> | undefined;

export function configurarAutenticacao(): Promise<void> {
  if (!configuracao) {
    configuracao = carregarConfig()
      .then(({ cognito }) => {
        if (!cognito.userPoolId || !cognito.userPoolClientId) {
          throw new Error(
            "A autenticação aguarda os identificadores do deploy Cognito."
          );
        }

        if (!cognito.userPoolId.startsWith(`${cognito.region}_`)) {
          throw new Error(
            "O User Pool não pertence à região configurada."
          );
        }

        Amplify.configure({
          Auth: {
            Cognito: {
              userPoolId: cognito.userPoolId,
              userPoolClientId: cognito.userPoolClientId,
              loginWith: {
                email: true,
              },
              passwordFormat: {
                minLength: 12,
                requireLowercase: true,
                requireUppercase: true,
                requireNumbers: true,
                requireSpecialCharacters: true,
              },
            },
          },
        });
      })
      .catch((erro) => {
        configuracao = undefined;
        throw erro;
      });
  }

  return configuracao;
}

export async function obterAccessToken(): Promise<string> {
  await configurarAutenticacao();

  const sessao = await fetchAuthSession();
  const token = sessao.tokens?.accessToken;

  if (!token) {
    throw new Error(
      "Sua sessão terminou. Entre novamente para continuar."
    );
  }

  return token.toString();
}

export async function encerrarSessao(): Promise<void> {
  await configurarAutenticacao();
  await signOut();
}