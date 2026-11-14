"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import LoadingScreen from "../components/LoadingScreen";
import ChatWindow from "../components/ChatWindow";
import { buscarPerfil, SessaoExpiradaError } from "../services/api";
import {
  configurarAutenticacao,
  encerrarSessao,
} from "../services/auth";
import { fetchAuthSession } from "aws-amplify/auth";
import type { Usuario } from "../types";

export default function HomePage() {
  const router = useRouter();
  const [usuario, setUsuario] = useState<Usuario | null>(null);
  const [pronto, setPronto] = useState(false);
  const [erro, setErro] = useState("");

  useEffect(() => {
    let ativo = true;

    async function iniciar() {
      try {
        await configurarAutenticacao();

        const sessao = await fetchAuthSession();

        if (!sessao.tokens?.accessToken) {
          router.replace("/login");
          return;
        }

        const perfil = await buscarPerfil();

        if (ativo) {
          setUsuario(perfil);
        }
      } catch (falha) {
        if (!ativo) return;

        if (falha instanceof SessaoExpiradaError) {
          router.replace("/login");
          return;
        }

        setErro(
          falha instanceof Error
            ? falha.message
            : "Não foi possível iniciar sua sessão.",
        );
      }
    }

    void iniciar();

    return () => {
      ativo = false;
    };
  }, [router]);

  async function sair() {
    try {
      await encerrarSessao();
      router.replace("/login");
    } catch {
      setErro("Não foi possível sair. Tente novamente.");
    }
  }

  if (erro) {
    return (
      <main>
        <p role="alert">{erro}</p>
        <button type="button" onClick={() => window.location.reload()}>
          Tentar novamente
        </button>
        <button type="button" onClick={sair}>
          Sair da conta
        </button>
      </main>
    );
  }

  if (!usuario) {
    return <p role="status">Verificando sua sessão…</p>;
  }

  if (!pronto) {
    return <LoadingScreen onConcluido={() => setPronto(true)} />;
  }

  return <ChatWindow usuarioInicial={usuario} />;
}