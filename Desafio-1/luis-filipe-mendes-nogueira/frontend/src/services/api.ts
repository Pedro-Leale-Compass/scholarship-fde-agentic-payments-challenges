// gemini-chat/src/services/api.ts
import type { Content } from "../types";
import type { Usuario, RespostaChat } from "../types";
import { carregarConfig } from "./config";

export async function login(
  username: string,
  senha: string,
): Promise<string> {
  const { authUrl } = await carregarConfig();

  const resp = await fetch(`${authUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, senha }),
  });

  if (!resp.ok) {
    throw new Error("E-mail ou senha não conferem.");
  }

  const dados = await resp.json();
  return dados.token as string;
}

export async function buscarPerfil(token: string): Promise<Usuario> {
  const { authUrl } = await carregarConfig();

  const resp = await fetch(`${authUrl}/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    throw new Error("Não conseguimos confirmar sua conta.");
  }

  return resp.json();
}

export async function enviarMensagem(
  token: string,
  historicoAtual: Content[],
  textoUsuario: string,
): Promise<RespostaChat> {
  const { chatUrl } = await carregarConfig();

  const mensagens: Content[] = [
    ...historicoAtual,
    { role: "user", parts: [{ text: textoUsuario }] },
  ];

  const resp = await fetch(chatUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      messages: mensagens,
      maxIteracoes: 5,
    }),
  });

  if (!resp.ok) {
    throw new Error("Não conseguimos abrir sua conversa agora.");
  }

  return resp.json();
}

export async function registrar(
  username: string,
  senha: string,
): Promise<string> {
  const { authUrl } = await carregarConfig();

  const resp = await fetch(`${authUrl}/registrar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, senha }),
  });

  if (!resp.ok) {
    const dados = await resp.json().catch(() => ({}));
    throw new Error(dados.mensagem || "Não foi possível criar sua conta.");
  }

  const dados = await resp.json();
  return dados.token as string;
}
