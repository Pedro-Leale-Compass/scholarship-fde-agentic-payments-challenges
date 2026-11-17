"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Authenticator } from "@aws-amplify/ui-react";
import { configurarAutenticacao } from "../services/auth";

const CATEGORIAS = ["show", "teatro", "festival", "esporte"];

const COMPONENTES_AUTH = {
  SignIn: {
    Header() {
      return (
        <div className="ig-login-cognito__introducao">
          <h1>Entrar na sua conta</h1>
          <p>Use o e-mail e a senha do seu acesso por convite.</p>
        </div>
      );
    },
  },
};

const CAMPOS_AUTH = {
  signIn: {
    username: {
      label: "E-mail",
      placeholder: "voce@exemplo.com",
      isRequired: true,
    },
    password: {
      label: "Senha",
      placeholder: "Digite sua senha",
      isRequired: true,
    },
  },
};

function RedirecionarParaChat() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/");
  }, [router]);

  return <p role="status">Abrindo sua sessão…</p>;
}

export default function LoginCognito() {
  const [pronto, setPronto] = useState(false);
  const [erro, setErro] = useState("");

  useEffect(() => {
    let ativo = true;

    async function preparar() {
      try {
        await configurarAutenticacao();

        if (ativo) {
          setPronto(true);
        }
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

  return (
    <main className="ig-tela-login ig-login-cognito">
      <section
        className="ig-marca-painel"
        aria-label="Ingressos"
      >
        <div className="ig-quadro-marca" aria-hidden="true" />

        <p className="ig-marca-painel__chamada">
          Fale o que você quer ver. A gente resolve o resto.
        </p>

        <div className="ig-escrita__atalhos ig-login-cognito__categorias">
          {CATEGORIAS.map((categoria) => (
            <span key={categoria} className="ig-chip">
              {categoria}
            </span>
          ))}
        </div>
      </section>

      <section
        className="ig-tela-login__form-col"
        aria-label="Acesso à conta"
      >
        {erro ? (
          <p role="alert">{erro}</p>
        ) : !pronto ? (
          <p role="status">Preparando autenticação…</p>
        ) : (
          <Authenticator
            hideSignUp
            loginMechanisms={["email"]}
            components={COMPONENTES_AUTH}
            formFields={CAMPOS_AUTH}
          >
            {() => <RedirecionarParaChat />}
          </Authenticator>
        )}
      </section>
    </main>
  );
}