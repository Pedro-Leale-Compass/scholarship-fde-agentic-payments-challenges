import type { Conversa, PendenciaChat } from "../types/chat";
import { registro } from "../types/chat";

const chave = (usuario: string, conversa: string) =>
  `pagamentos:pendente:${usuario}:${conversa}`;

export function lerPendencia(
  usuario: string,
  conversa: string,
): PendenciaChat | null {
  try {
    const bruto = sessionStorage.getItem(chave(usuario, conversa));
    const item = bruto ? registro(JSON.parse(bruto)) : null;

    if (
      item?.conversa_id === conversa &&
      typeof item.requisicao_id === "string" &&
      typeof item.mensagem === "string" &&
      item.mensagem.length <= 4000
    ) {
      return item as unknown as PendenciaChat;
    }
  } catch {
    // O navegador pode bloquear o armazenamento.
  }

  return null;
}

export function guardarPendencia(usuario: string, pedido: PendenciaChat) {
  try {
    sessionStorage.setItem(
      chave(usuario, pedido.conversa_id),
      JSON.stringify(pedido),
    );
  } catch {
    // A proteção do backend continua válida.
  }
}

export function limparPendencia(usuario: string, conversa: string) {
  try {
    sessionStorage.removeItem(chave(usuario, conversa));
  } catch {}
}

export function guardarConversaSelecionada(usuario: string, conversa: string) {
  try {
    sessionStorage.setItem(`pagamentos:conversa:${usuario}`, conversa);
  } catch {}
}

export function lerConversaSelecionada(usuario: string): string | null {
  try {
    return sessionStorage.getItem(`pagamentos:conversa:${usuario}`);
  } catch {
    return null;
  }
}

export function pendenciaConcluida(
  conversa: Conversa,
  pendencia: PendenciaChat,
): boolean {
  return conversa.conversa_id === pendencia.conversa_id &&
    conversa.requisicao?.requisicao_id === pendencia.requisicao_id &&
    conversa.requisicao.estado === "concluida" &&
    conversa.requisicao.versao !== null &&
    conversa.versao >= conversa.requisicao.versao;
}

export function podeReenviar(
  conversa: Conversa,
  pendencia: PendenciaChat,
): boolean {
  return conversa.conversa_id === pendencia.conversa_id &&
    conversa.estado === "livre" &&
    conversa.requisicao?.requisicao_id === pendencia.requisicao_id &&
    conversa.requisicao.estado === "nao_recebida";
}
