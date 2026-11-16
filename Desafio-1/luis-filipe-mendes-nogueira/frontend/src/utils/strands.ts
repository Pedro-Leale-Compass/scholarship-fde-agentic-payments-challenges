import type { Content, MensagemUI } from "../types";
import type { MensagemStrands } from "../types/chat";
import { registro } from "../types/chat";

export function historicoParaMensagens(
  historico: MensagemStrands[],
): MensagemUI[] {
  return historico.flatMap((mensagem, indice) => {
    const texto = mensagem.content
      .map((parte) => typeof parte.text === "string" ? parte.text : "")
      .filter(Boolean)
      .join("\n\n");

    if (!texto.trim()) return [];

    return [{
      id: mensagem.tracking_id ?? `mensagem-${indice}`,
      role: mensagem.role === "assistant" ? "model" as const : "user" as const,
      texto,
    }];
  });
}

export function historicoParaContent(
  historico: MensagemStrands[],
): Content[] {
  const ferramentas = new Map<string, string>();

  return historico.map((mensagem) => {
    const parts: Content["parts"] = [];

    for (const bloco of mensagem.content) {
      if (typeof bloco.text === "string") {
        parts.push({ text: bloco.text });
      }

      const uso = registro(bloco.toolUse);

      if (
        uso &&
        typeof uso.toolUseId === "string" &&
        typeof uso.name === "string"
      ) {
        ferramentas.set(uso.toolUseId, uso.name);

        parts.push({
          functionCall: {
            name: uso.name,
            args: registro(uso.input) ?? {},
          },
        });
      }

      const resultado = registro(bloco.toolResult);

      if (
        !resultado ||
        typeof resultado.toolUseId !== "string" ||
        !Array.isArray(resultado.content) ||
        resultado.status === "error"
      ) {
        continue;
      }

      const nome = ferramentas.get(resultado.toolUseId);
      if (!nome) continue;

      for (const bruto of resultado.content) {
        const item = registro(bruto);
        if (!item) continue;

        let conteudo: unknown = item.json;

        if (typeof item.text === "string") {
          try {
            conteudo = JSON.parse(item.text);
          } catch {
            continue;
          }
        }

        if (!registro(conteudo)) continue;

        parts.push({
          functionResponse: {
            name: nome,
            response: { name: nome, content: conteudo },
          },
        });
      }
    }

    return {
      role: mensagem.role === "assistant" ? "model" : "user",
      parts,
    };
  });
}
