interface ConfigPublica {
  apiUrl: string;
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

        if (typeof dados.apiUrl !== "string") {
          throw new Error("Configuração inválida: apiUrl.");
        }

        const apiUrl = dados.apiUrl.trim().replace(/\/+$/, "");

        if (apiUrl) {
          const url = new URL(apiUrl);

          if (!["http:", "https:"].includes(url.protocol)) {
            throw new Error("Protocolo inválido para a API.");
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

        return { apiUrl, cognito };
      })
      .catch((erro) => {
        carregamento = undefined;
        throw erro;
      });
  }

  return carregamento;
}