import type { Usuario } from "../types";
import { registro } from "../types/chat";
import { carregarConfig } from "./config";
import { obterAccessToken } from "./auth";

export class SessaoExpiradaError extends Error {
  constructor() {
    super("Sua sessão terminou. Entre novamente para continuar.");
    this.name = "SessaoExpiradaError";
  }
}

export class ErroApi extends Error {
  constructor(
    public readonly status: number,
    public readonly codigo: string,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = "ErroApi";
  }
}

export async function requisicaoAutenticada(
  caminho: string,
  opcoes: RequestInit = {},
  destino: "perfil" | "chat" = "perfil",
): Promise<Response> {
  const config = await carregarConfig();
  const base = destino === "chat" ? config.chatApiUrl : config.apiUrl;

  if (!base) {
    throw new ErroApi(
      0,
      "SERVICO_INDISPONIVEL",
      "A conversa está indisponível no momento.",
    );
  }

  const token = await obterAccessToken();
  const headers = new Headers(opcoes.headers);
  headers.set("Authorization", `Bearer ${token}`);

  let resposta: Response;

  try {
    resposta = await fetch(`${base}${caminho}`, {
      ...opcoes,
      headers,
      cache: "no-store",
      credentials: "omit",
      signal: opcoes.signal ?? AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ErroApi(
      0,
      "CONEXAO_INTERROMPIDA",
      "A conexão foi interrompida. Verifique o resultado antes de reenviar.",
    );
  }

  if (resposta.status === 401) {
    throw new SessaoExpiradaError();
  }

  if (!resposta.ok) {
    let dados: Record<string, unknown> | null = null;

    try {
      dados = registro(await resposta.json());
    } catch {
      // Erros do próprio API Gateway podem não conter JSON.
    }

    throw new ErroApi(
      resposta.status,
      typeof dados?.erro === "string" ? dados.erro : "ERRO_API",
      typeof dados?.mensagem === "string"
        ? dados.mensagem
        : "Não foi possível concluir esta solicitação.",
    );
  }

  return resposta;
}

export async function buscarPerfil(): Promise<Usuario> {
  const resposta = await requisicaoAutenticada("/me");
  return resposta.json();
}

export interface SessaoAutenticada {
  usuario_id: string;
}

export async function buscarSessao(): Promise<SessaoAutenticada> {
  const resposta = await requisicaoAutenticada("/sessao");
  return resposta.json();
}
