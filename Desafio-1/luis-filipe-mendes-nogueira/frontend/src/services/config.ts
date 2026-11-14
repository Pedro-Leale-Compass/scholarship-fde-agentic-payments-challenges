interface ConfigPublica {
  authUrl: string;
  chatUrl: string;
  cognito: {
    region: string;
    userPoolId: string;
    userPoolClientId: string;
  };
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

          if (!["http:", "https:"].includes(url.protocol)) {
            throw new Error(`Protocolo inválido: ${campo}.`);
          }
        }

        const cognito = dados.cognito;

        if (
          !cognito ||
          cognito.region !== "us-east-1" ||
          typeof cognito.userPoolId !== "string" ||
          typeof cognito.userPoolClientId !== "string"
        ) {
          throw new Error("Configuração do Cognito inválida.");
        }

        return {
          authUrl: dados.authUrl.replace(/\/+$/, ""),
          chatUrl: dados.chatUrl,
          cognito,
        };
      })
      .catch((erro) => {
        carregamento = undefined;
        throw erro;
      });
  }

  return carregamento;
}