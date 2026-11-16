
import { getCurrentSession, getIdToken } from "./auth";

const apiUrl = import.meta.env.VITE_API_URL;

// Identificador da conversa mantido em memória.
let sessionId = crypto.randomUUID();

export type MetodoPagamento = "PIX" | "CARTAO";

export type ResultadoPagamento = {
  sucesso: boolean;
  erro?: string;
  mensagem?: string;
  transacao_id?: string;
  intencao_id?: string;
  status?: string;
  metodo_pagamento?: MetodoPagamento;
  valor_total?: number;
  idempotente?: boolean;
};

// Reinicia a conversa.
export function reiniciarSessaoChat(): void {
  sessionId = crypto.randomUUID();
}

async function obterToken(): Promise<string> {
  const session = await getCurrentSession();

  if (!session) {
    throw new Error("Sessão expirada. Faça login novamente.");
  }

  return getIdToken(session);
}

function obterApiUrl(): string {
  if (!apiUrl) {
    throw new Error("URL da API não configurada no .env.local.");
  }

  return apiUrl.replace(/\/$/, "");
}

export async function enviarMensagem(
  mensagem: string
): Promise<string> {
  const token = await obterToken();

  const response = await fetch(
    `${obterApiUrl()}/chat`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        mensagem,
        sessao_id: sessionId,
      }),
    }
  );

  let data: { resposta?: string; erro?: string };

  try {
    data = await response.json();
  } catch {
    throw new Error("A API retornou uma resposta inválida.");
  }

  if (!response.ok) {
    throw new Error(
      data.erro ||
      `Erro ao consultar o agente (HTTP ${response.status}).`
    );
  }

  if (typeof data.resposta !== "string") {
    throw new Error(
      "A resposta do agente não contém uma mensagem válida."
    );
  }

  return data.resposta;
}

export async function confirmarPagamento(
  intencaoId: string,
  metodoPagamento: MetodoPagamento
): Promise<ResultadoPagamento> {
  const token = await obterToken();

  const response = await fetch(
    `${obterApiUrl()}/confirmar-pagamento`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        intencao_id: intencaoId,
        metodo_pagamento: metodoPagamento,
      }),
    }
  );

  let data: ResultadoPagamento;

  try {
    data = await response.json();
  } catch {
    throw new Error("A API retornou uma resposta inválida.");
  }

  if (!response.ok || !data.sucesso) {
    throw new Error(
      data.mensagem ||
      data.erro ||
      `Não foi possível confirmar o pagamento (HTTP ${response.status}).`
    );
  }

  return data;
}
