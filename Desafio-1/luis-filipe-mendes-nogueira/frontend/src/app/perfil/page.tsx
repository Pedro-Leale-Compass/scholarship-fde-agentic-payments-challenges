"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { buscarPerfil } from "../../services/api";
import type { Usuario } from "../../types";

export default function PerfilPage() {
  const [perfil, setPerfil] = useState<Usuario | null>(null);
  const [erro, setErro] = useState("");

  useEffect(() => {
    let ativo = true;

    async function carregar() {
      try {
        const resultado = await buscarPerfil();

        if (ativo) {
          setPerfil(resultado);
        }
      } catch (falha) {
        if (ativo) {
          setErro(
            falha instanceof Error
              ? falha.message
              : "Não foi possível carregar o perfil.",
          );
        }
      }
    }

    void carregar();

    return () => {
      ativo = false;
    };
  }, []);

  return (
    <main>
      <h1>Meu perfil</h1>

      {erro ? (
        <p role="alert">{erro}</p>
      ) : perfil ? (
        <>
          <p>
            Identificador: <code>{perfil.id}</code>
          </p>

          <p>Usuário: {perfil.username}</p>

          <p>
            Limite disponível:{" "}
            {new Intl.NumberFormat("pt-BR", {
              style: "currency",
              currency: "BRL",
            }).format(perfil.limiteGasto)}
          </p>
        </>
      ) : (
        <p role="status">Carregando perfil…</p>
      )}

      <Link href="/">Voltar</Link>
      {" · "}
      <Link href="/login/">Login</Link>
    </main>
  );
}