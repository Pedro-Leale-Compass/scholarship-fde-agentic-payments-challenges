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

export default function HomePage() {
  const router = useRouter();
  const [usuario, setUsuario] = useState<Usuario | null>(null);
  const [erro, setErro] = useState("");
  const [saindo, setSaindo] = useState(false);

  useEffect(() => {
    let ativo = true;

    async function iniciar() {
      try {
        await configurarAutenticacao();
        const sessao = await fetchAuthSession();

        if (!ativo) return;

        if (!sessao.tokens?.accessToken) {
          router.replace("/login");
          return;
        }

        const perfil = await buscarPerfil();

        if (ativo) setUsuario(perfil);
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
    return () => { ativo = false; };
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

  if (usuario) return <ChatWindow usuarioInicial={usuario} />;

  return (
    <main>
      <h1>Agente de Pagamentos</h1>
      {erro ? <p role="alert">{erro}</p> : (
        <p role="status">Carregando seu perfil…</p>
      )}

      {erro && (
        <>
          <button
            type="button"
            onClick={() => window.location.reload()}
            disabled={saindo}
          >
            Tentar novamente
          </button>
          <button type="button" onClick={() => void sair()} disabled={saindo}>
            {saindo ? "Saindo…" : "Sair da conta"}
          </button>
        </>
      )}
    </main>
  );
}
