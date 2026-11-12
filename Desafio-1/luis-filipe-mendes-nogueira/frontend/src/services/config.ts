interface ConfigPublica {
  authUrl: string;
  chatUrl: string;
}

let carregamento: Promise<ConfigPublica> | undefined;

export function carregarConfig(): Promise<ConfigPublica> {
  if (!carregamento) {
    carregamento = fetch("/config.json", { cache: "no-store" })
      .then(async (resposta) => {
        if (!resposta.ok) {
          throw new Error("Não foi possível carregar a configuração.");
        }

        const dados = await resposta.json();

        for (const campo of ["authUrl", "chatUrl"]) {
          if (typeof dados[campo] !== "string") {
            throw new Error(`Configuração inválida: ${campo}.`);
          }

          const url = new URL(dados[campo]);

          if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new Error(`Protocolo inválido: ${campo}.`);
          }
        }

        return {
          authUrl: dados.authUrl.replace(/\/+$/, ""),
          chatUrl: dados.chatUrl,
        };
      })
      .catch((erro) => {
        carregamento = undefined;
        throw erro;
      });
  }

  return carregamento;
}