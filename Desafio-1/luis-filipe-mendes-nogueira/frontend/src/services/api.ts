import type { Content, Usuario, RespostaChat } from "../types";
import { carregarConfig } from "./config";
import { obterAccessToken } from "./auth";

export class SessaoExpiradaError extends Error {
  constructor() {
    super("Sua sessão terminou. Entre novamente para continuar.");
    this.name = "SessaoExpiradaError";
  }
}

async function requisicaoAutenticada(
  caminho: string,
  opcoes: RequestInit = {},
): Promise<Response> {
  const { apiUrl } = await carregarConfig();

  if (!apiUrl) {
    throw new Error("A API aguarda o deploy na AWS.");
  }

  const token = await obterAccessToken();
  const headers = new Headers(opcoes.headers);

  headers.set("Authorization", `Bearer ${token}`);

  const resposta = await fetch(`${apiUrl}${caminho}`, {
    ...opcoes,
    headers,
    cache: "no-store",
  });

  if (resposta.status === 401) {
    throw new SessaoExpiradaError();
  }

  return resposta;
}

export async function buscarPerfil(): Promise<Usuario> {
  const resposta = await requisicaoAutenticada("/me");

  if (!resposta.ok) {
    throw new Error("Não conseguimos carregar seus dados agora.");
  }

  return resposta.json();
}

export async function enviarMensagem(
  historicoAtual: Content[],
  textoUsuario: string,
): Promise<RespostaChat> {
  const mensagens: Content[] = [
    ...historicoAtual,
    { role: "user", parts: [{ text: textoUsuario }] },
  ];

  const resposta = await requisicaoAutenticada("/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: mensagens,
      maxIteracoes: 5,
    }),
  });

  if (!resposta.ok) {
    throw new Error("Não conseguimos abrir sua conversa agora.");
  }

  return resposta.json();
}

export interface SessaoAutenticada {
  usuario_id: string;
}

export async function buscarSessao(): Promise<SessaoAutenticada> {
  const resposta = await requisicaoAutenticada("/sessao");

  if (!resposta.ok) {
    throw new Error("Não foi possível confirmar sua sessão.");
  }

  return resposta.json();
}