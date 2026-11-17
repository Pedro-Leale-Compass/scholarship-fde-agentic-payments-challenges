"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchAuthSession } from "aws-amplify/auth";
import type { Usuario } from "../types";
import { buscarPerfil, SessaoExpiradaError } from "../services/api";
import {
  configurarAutenticacao,
  encerrarSessao,
} from "../services/auth";
import ChatWindow from "../components/ChatWindow";
import LoadingScreen from "../components/LoadingScreen";

export default function HomePage() {
  const router = useRouter();
  const [usuario, setUsuario] = useState<Usuario | null>(null);
  const [etapaAtual, setEtapaAtual] = useState(0);
  const [erro, setErro] = useState("");
  const [saindo, setSaindo] = useState(false);

  useEffect(() => {
    let ativo = true;

    async function iniciar() {
      try {
        await configurarAutenticacao();

        if (!ativo) return;
        setEtapaAtual(1);

        const sessao = await fetchAuthSession();

        if (!ativo) return;

        if (!sessao.tokens?.accessToken) {
          router.replace("/login");
          return;
        }

        setEtapaAtual(2);

        const perfil = await buscarPerfil();

        if (!ativo) return;

        setEtapaAtual(3);
        setUsuario(perfil);
      } catch (falha) {
        if (!ativo) return;

        if (falha instanceof SessaoExpiradaError) {
          setErro(
            "Não foi possível validar seu acesso ao perfil. Saia da conta e entre novamente.",
          );
          return;
        }

        setErro("Não foi possível carregar seu perfil. Tente novamente.");
      }
    }

    void iniciar();

    return () => {
      ativo = false;
    };
  }, [router]);

  async function sair() {
    if (saindo) return;

    setSaindo(true);

    try {
      await encerrarSessao();
      router.replace("/login");
    } catch {
      setErro("Não foi possível sair. Tente novamente.");
      setSaindo(false);
    }
  }

  if (usuario) {
    return <ChatWindow usuarioInicial={usuario} />;
  }

  return (
    <LoadingScreen
      etapaAtual={etapaAtual}
      erro={erro}
      saindo={saindo}
      onTentarNovamente={() => window.location.reload()}
      onSair={() => void sair()}
    />
  );
}
