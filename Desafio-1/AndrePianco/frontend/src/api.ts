import { fetchAuthSession } from "aws-amplify/auth";
import { config } from "./config.js";

/** Eventos que POST /chat envia em stream (SSE). */
export type EventoChat =
  | { tipo: "texto"; delta: string }
  | { tipo: "tool_chamada"; id: string; nome: string; argumentos: Record<string, unknown> }
  | { tipo: "tool_resultado"; id: string; resultado: unknown }
  | { tipo: "erro"; mensagem: string }
  | { tipo: "fim"; motivo?: string };

/** Mensagem do historico, no formato Bedrock Converse salvo no DynamoDB. */
export interface MensagemConverse {
  role: "user" | "assistant";
  content: Array<{
    text?: string;
    toolUse?: { toolUseId: string; name: string; input: Record<string, unknown> };
    toolResult?: { toolUseId: string; content: Array<{ text?: string }> };
  }>;
}

export class ErroApi extends Error {
  constructor(public status: number, mensagem: string) {
    super(mensagem);
  }
}

/**
 * Cabecalho com o ID token do Cognito. O Amplify renova o token sozinho
 * quando expira. O backend valida o token a cada requisicao (autorizador
 * do API Gateway) -- esconder o chat na tela nao e controle de acesso.
 */
async function autorizacao(): Promise<Record<string, string>> {
  const { tokens } = await fetchAuthSession();
  const token = tokens?.idToken?.toString();
  if (!token) throw new ErroApi(401, "Sua sessão expirou. Entre novamente.");
  return { Authorization: `Bearer ${token}` };
}

async function erroDaResposta(res: Response): Promise<ErroApi> {
  if (res.status === 401) return new ErroApi(401, "Sua sessão expirou. Entre novamente.");
  if (res.status === 429) return new ErroApi(429, "Muitas mensagens seguidas. Aguarde alguns segundos.");
  const corpo = await res.json().catch(() => ({}));
  return new ErroApi(res.status, corpo.erro ?? "Não foi possível falar com o servidor.");
}

export async function carregarHistorico(): Promise<MensagemConverse[]> {
  const res = await fetch(`${config.apiUrl}/conversas`, { headers: await autorizacao() });
  if (!res.ok) throw await erroDaResposta(res);
  return (await res.json()).mensagens ?? [];
}

export async function apagarHistorico(): Promise<void> {
  const res = await fetch(`${config.apiUrl}/conversas`, { method: "DELETE", headers: await autorizacao() });
  if (!res.ok) throw await erroDaResposta(res);
}

/** Envia a mensagem e chama `aoReceber` para cada evento, conforme chegam. */
export async function enviarMensagem(mensagem: string, aoReceber: (ev: EventoChat) => void): Promise<void> {
  const res = await fetch(`${config.apiUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await autorizacao()) },
    body: JSON.stringify({ mensagem }),
  });
  if (!res.ok || !res.body) throw await erroDaResposta(res);

  const leitor = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let pendente = "";
  for (;;) {
    const { value, done } = await leitor.read();
    if (done) break;
    pendente += value;
    let quebra: number;
    while ((quebra = pendente.indexOf("\n")) >= 0) {
      const linha = pendente.slice(0, quebra).trim();
      pendente = pendente.slice(quebra + 1);
      if (!linha.startsWith("data:")) continue;
      try {
        aoReceber(JSON.parse(linha.slice(5).trim()) as EventoChat);
      } catch {
        /* linha incompleta ou invalida: ignora */
      }
    }
  }
}
