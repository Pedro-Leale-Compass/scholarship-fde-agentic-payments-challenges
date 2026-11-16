export interface ConfigPublica {
  apiUrl: string;
  chatApiUrl: string;
  cognito: {
    region: string;
    userPoolId: string;
    userPoolClientId: string;
  };
}

let carregamento: Promise<ConfigPublica> | undefined;

function normalizarUrl(valor: unknown, campo: string): string {
  if (typeof valor !== "string") {
    throw new Error(`Configuração inválida: ${campo}.`);
  }

  const endereco = valor.trim().replace(/\/+$/, "");

  if (endereco) {
    const url = new URL(endereco);

    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error(`Protocolo inválido: ${campo}.`);
    }
  }

  return endereco;
}

export function carregarConfig(): Promise<ConfigPublica> {
  if (!carregamento) {
    carregamento = fetch("/config.json", { cache: "no-store" })
      .then(async (resposta) => {
        if (!resposta.ok) {
          throw new Error("Não foi possível carregar a configuração.");
        }

        const dados = await resposta.json();

        const apiUrl = normalizarUrl(dados.apiUrl, "apiUrl");
        const chatApiUrl = normalizarUrl(
          dados.chatApiUrl ?? "",
          "chatApiUrl",
        );

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
          apiUrl,
          chatApiUrl,
          cognito: {
            region: cognito.region,
            userPoolId: cognito.userPoolId,
            userPoolClientId: cognito.userPoolClientId,
          },
        };
      })
      .catch((erro) => {
        carregamento = undefined;
        throw erro;
      });
  }

  return carregamento;
}
