"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Authenticator } from "@aws-amplify/ui-react";
import { configurarAutenticacao } from "../services/auth";

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

  if (erro) {
    return <p role="alert">{erro}</p>;
  }

  if (!pronto) {
    return <p role="status">Preparando autenticação…</p>;
  }

  return (
    <Authenticator hideSignUp loginMechanisms={["email"]}>
      {() => <RedirecionarParaChat />}
    </Authenticator>
  );
}