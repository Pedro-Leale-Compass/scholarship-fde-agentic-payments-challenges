import { fetchAuthSession } from 'aws-amplify/auth';

// Gerado pelo deploy (infra/scripts/gerar-config.mjs) em frontend/.env.local; nada fixo no código.
const API_URL = import.meta.env.VITE_API_URL;

async function authHeader() {
  const { tokens } = await fetchAuthSession();
  if (!tokens?.idToken) throw new Error('Sessão expirada. Entre novamente.');
  return { Authorization: `Bearer ${tokens.idToken.toString()}` };
}

export const getHistory = async () => {
  const res = await fetch(`${API_URL}/conversas`, { headers: await authHeader() });
  if (!res.ok) throw new Error('Não foi possível carregar o histórico.');
  return res.json();
};

/** Envia a mensagem e chama onChunk a cada pedaço de texto que chega (streaming). */
export const sendMessage = async (message, onChunk) => {
  const res = await fetch(`${API_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.detail || error.message || `Erro na API (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(decoder.decode(value, { stream: true }));
  }
};
