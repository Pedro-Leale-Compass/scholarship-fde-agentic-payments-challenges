// Lê um corpo NDJSON (uma linha JSON por evento) conforme os bytes chegam. Os
// pedaços da rede podem cortar uma linha, ou um caractere UTF-8, no meio.
export async function* lerNdjson(corpo: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
    const leitor = corpo.getReader()
    const decodificador = new TextDecoder("utf-8")
    let pendente = ""
    try {
        for (;;) {
            const { value, done } = await leitor.read()
            if (done) break
            pendente += decodificador.decode(value, { stream: true })
            const linhas = pendente.split("\n")
            pendente = linhas.pop() ?? ""
            for (const linha of linhas) {
                if (linha.trim() !== "") yield JSON.parse(linha)
            }
        }
        pendente += decodificador.decode()
        if (pendente.trim() !== "") yield JSON.parse(pendente)
    } finally {
        leitor.releaseLock()
    }
}
