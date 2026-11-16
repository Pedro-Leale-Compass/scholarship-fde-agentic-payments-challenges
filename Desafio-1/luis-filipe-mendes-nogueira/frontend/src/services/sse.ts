export async function* lerEventosSse(
  fluxo: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const leitor = fluxo.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  let buffer = "";
  let dados: string[] = [];
  let tamanhoEvento = 0;
  let tamanhoTotal = 0;

  try {
    while (true) {
      const { value, done } = await leitor.read();

      if (done) break;

      tamanhoTotal += value.byteLength;

      if (tamanhoTotal > 8_000_000) {
        throw new Error("Resposta muito extensa.");
      }

      buffer += decoder.decode(value, { stream: true });

      if (buffer.length > 2_000_000) {
        throw new Error("Evento muito extenso.");
      }

      let posicao: number;

      while ((posicao = buffer.indexOf("\n")) >= 0) {
        const linha = buffer.slice(0, posicao).replace(/\r$/, "");
        buffer = buffer.slice(posicao + 1);

        if (linha === "") {
          if (dados.length) {
            const texto = dados.join("\n");

            if (texto !== "[DONE]") {
              yield JSON.parse(texto);
            }
          }

          dados = [];
          tamanhoEvento = 0;
          continue;
        }

        if (linha.startsWith("data:")) {
          const valor = linha.slice(5).replace(/^ /, "");
          tamanhoEvento += valor.length;

          if (tamanhoEvento > 2_000_000) {
            throw new Error("Evento muito extenso.");
          }

          dados.push(valor);
        }
      }
    }

    buffer += decoder.decode();

    if (buffer.trim() || dados.length) {
      throw new Error("Resposta interrompida.");
    }
  } finally {
    try {
      await leitor.cancel();
    } catch {
      // A conexão pode já estar encerrada.
    }

    leitor.releaseLock();
  }
}
