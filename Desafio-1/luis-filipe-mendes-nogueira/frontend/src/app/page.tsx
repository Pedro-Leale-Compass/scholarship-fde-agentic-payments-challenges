"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  buscarSessao,
  SessaoExpiradaError,
  type SessaoAutenticada,
} from "../services/api";
import {
  configurarAutenticacao,
  encerrarSessao,
} from "../services/auth";
import { fetchAuthSession } from "aws-amplify/auth";

export default function HomePage() {
  const router = useRouter();

  const [sessao, setSessao] = useState<SessaoAutenticada | null>(null);
  const [erro, setErro] = useState("");
  const [saindo, setSaindo] = useState(false);

  useEffect(() => {
    let ativo = true;

    async function iniciar() {
      try {
        await configurarAutenticacao();

        const autenticacao = await fetchAuthSession();

        if (!autenticacao.tokens?.accessToken) {
          router.replace("/login");
          return;
        }

        const resultado = await buscarSessao();

        if (ativo) {
          setSessao(resultado);
        }
      } catch (falha) {
        if (!ativo) return;

        if (falha instanceof SessaoExpiradaError) {
          setErro("Sua sessão não foi aceita pela API. Saia e entre novamente.");
          return;
        }

        setErro(
          falha instanceof Error
            ? falha.message
            : "Não foi possível confirmar sua sessão.",
        );
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

  return (
    <main>
      <h1>Agente de Pagamentos</h1>

      {erro ? (
        <p role="alert">{erro}</p>
      ) : sessao ? (
        <>
          <p>Sessão autenticada confirmada pela API.</p>
          <p>
            Identificador do usuário: <code>{sessao.usuario_id}</code>
          </p>
          <p>O chat será integrado nas próximas etapas.</p>
        </>
      ) : (
        <p role="status">Verificando sua sessão…</p>
      )}

      {erro && (
        <button
          type="button"
          onClick={() => window.location.reload()}
          disabled={saindo}
        >
          Tentar novamente
        </button>
      )}

      <button
        type="button"
        onClick={() => void sair()}
        disabled={saindo}
      >
        {saindo ? "Saindo…" : "Sair da conta"}
      </button>
    </main>
  );
}