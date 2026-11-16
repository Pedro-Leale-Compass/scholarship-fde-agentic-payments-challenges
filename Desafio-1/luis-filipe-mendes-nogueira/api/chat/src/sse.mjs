export async function* lerSse(corpo) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let dados = [];
  let bytesEvento = 0;
  let bytesTotais = 0;

  for await (const pedaco of corpo) {
    bytesTotais += pedaco.byteLength;

    if (bytesTotais > 8_000_000) {
      throw new Error("Resposta do runtime muito extensa.");
    }

    buffer += decoder.decode(pedaco, { stream: true });

    if (Buffer.byteLength(buffer, "utf8") > 2_000_000) {
      throw new Error("Evento do runtime muito extenso.");
    }

    let posicao;

    while ((posicao = buffer.indexOf("\n")) >= 0) {
      const linha = buffer.slice(0, posicao).replace(/\r$/, "");
      buffer = buffer.slice(posicao + 1);

      if (linha === "") {
        if (dados.length) {
          const texto = dados.join("\n");

          if (texto !== "[DONE]") {
            const evento = JSON.parse(texto);

            if (!evento || typeof evento !== "object" || Array.isArray(evento)) {
              throw new Error("Evento inválido do runtime.");
            }

            yield evento;
          }
        }

        dados = [];
        bytesEvento = 0;
        continue;
      }

      if (linha.startsWith("data:")) {
        const valor = linha.slice(5).replace(/^ /, "");
        bytesEvento += Buffer.byteLength(valor, "utf8");

        if (bytesEvento > 2_000_000) {
          throw new Error("Evento do runtime muito extenso.");
        }

        dados.push(valor);
      }
    }
  }

  buffer += decoder.decode();

  if (buffer.trim() || dados.length) {
    throw new Error("O streaming terminou com um evento incompleto.");
  }
}
