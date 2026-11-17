import { lerToken } from "./auth.js";

const API_URL = import.meta.env.VITE_API_URL;

function processarLinha(linha: string, aoReceberPedaco: (texto: string) => void) {
  const limpa = linha.replace(/\r$/, "");
  if (!limpa.startsWith("data:")) return;
  const dado = limpa.slice(5).trim();
  if (!dado) return;
  try {
    const texto = JSON.parse(dado);
    if (typeof texto === "string") aoReceberPedaco(texto);
  } catch {
    aoReceberPedaco(dado);
  }
}

export async function enviarMensagem(
  mensagem: string,
  aoReceberPedaco: (texto: string) => void,
): Promise<void> {
  const token = await lerToken();

  const resposta = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ mensagem }),
  });

  if (!resposta.ok) {
    if (resposta.status === 401) throw new Error("Sessao expirada ou invalida. Entre novamente.");
    const corpo = await resposta.json().catch(() => ({}));
    throw new Error(corpo.erro ?? `Erro ${resposta.status} ao falar com o agente.`);
  }
  if (!resposta.body) throw new Error("Resposta vazia do servidor.");

  const leitor = resposta.body.pipeThrough(new TextDecoderStream()).getReader();
  let sobra = "";

  while (true) {
    const { value, done } = await leitor.read();
    if (done) break;
    sobra += value;
    const linhas = sobra.split("\n");
    sobra = linhas.pop() ?? "";
    for (const linha of linhas) processarLinha(linha, aoReceberPedaco);
  }
  if (sobra) processarLinha(sobra, aoReceberPedaco);
}