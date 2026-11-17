// Lê o stream SSE do AgentCore Runtime: cada evento é uma linha `data: {json}`
// seguida de linha em branco. Os chunks da rede podem cortar uma linha no meio,
// então o texto é acumulado até cada quebra de linha.
export async function* lerEventosSse(corpo: AsyncIterable<Uint8Array | string>): AsyncGenerator<unknown> {
    const decodificador = new TextDecoder("utf-8")
    let pendente = ""

    function* processar(linhas: string[]): Generator<unknown> {
        for (const linhaBruta of linhas) {
            const linha = linhaBruta.replace(/\r$/, "")
            if (!linha.startsWith("data:")) continue
            const dados = linha.slice(5).trim()
            if (dados === "") continue
            try {
                yield JSON.parse(dados)
            } catch {
                yield { tipo: "invalido" }
            }
        }
    }

    for await (const chunk of corpo) {
        pendente += typeof chunk === "string" ? chunk : decodificador.decode(chunk, { stream: true })
        const linhas = pendente.split("\n")
        pendente = linhas.pop() ?? ""
        yield* processar(linhas)
    }
    pendente += decodificador.decode()
    yield* processar([pendente])
}
