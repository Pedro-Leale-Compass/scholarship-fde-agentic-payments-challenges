"use client";

import { useEffect, useState } from "react";
import { Amplify } from "aws-amplify";
import { Authenticator } from "@aws-amplify/ui-react";
import { carregarConfig } from "../services/config";

export default function LoginCognito() {
  const [pronto, setPronto] = useState(false);
  const [erro, setErro] = useState("");

  useEffect(() => {
    let ativo = true;

    async function preparar() {
      try {
        const { cognito } = await carregarConfig();

        if (!cognito.userPoolId || !cognito.userPoolClientId) {
          throw new Error(
            "A autenticação aguarda os identificadores do deploy Cognito.",
          );
        }

        if (!cognito.userPoolId.startsWith(`${cognito.region}_`)) {
          throw new Error("O User Pool não pertence à região configurada.");
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

        if (ativo) setPronto(true);
      } catch (falha) {
        if (ativo) {
          setErro(
            falha instanceof Error
              ? falha.message
              : "Não foi possível preparar a autenticação.",
          );
        }
      }
    }

    void preparar();

    return () => {
      ativo = false;
    };
  }, []);

  if (erro) {
    return <p role="alert">{erro}</p>;
  }

  if (!pronto) {
    return <p role="status">Preparando autenticação…</p>;
  }

  return (
    <Authenticator hideSignUp loginMechanisms={["email"]}>
      {({ signOut }) => (
        <main>
          <h1>Login confirmado pelo Cognito</h1>
          <p>A integração desta sessão com o chat será feita no próximo passo.</p>

          <button type="button" onClick={() => signOut?.()}>
            Sair
          </button>
        </main>
      )}
    </Authenticator>
  );
}