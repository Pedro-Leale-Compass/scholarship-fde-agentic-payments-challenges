import { ErroHttp } from "./repositorio.mjs";

export function expiracaoEmSegundos(valor) {
  if (typeof valor === "number") {
    return Number.isFinite(valor) ? valor : NaN;
  }

  if (typeof valor !== "string") return NaN;

  const texto = valor.trim();

  if (/^\d+$/.test(texto)) {
    const numero = Number(texto);
    return Number.isSafeInteger(numero) ? numero : NaN;
  }

  const data = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+UTC\s+(\d{4})$/.exec(texto);

  if (!data) return NaN;

  const meses = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];

  const partes = [
    Number(data[6]),
    meses.indexOf(data[1]),
    Number(data[2]),
    Number(data[3]),
    Number(data[4]),
    Number(data[5]),
  ];

  const instante = new Date(Date.UTC(...partes));

  const normalizadas = [
    instante.getUTCFullYear(),
    instante.getUTCMonth(),
    instante.getUTCDate(),
    instante.getUTCHours(),
    instante.getUTCMinutes(),
    instante.getUTCSeconds(),
  ];

  if (partes.some((parte, indice) => parte !== normalizadas[indice])) {
    return NaN;
  }

  return instante.getTime() / 1000;
}

export function identidade(evento, clientId) {
  // A assinatura e o escopo são validados pelo autorizador do API Gateway.
  // A identidade continua vindo exclusivamente desse contexto.
  const claims = evento.requestContext?.authorizer?.claims;
  const expiracao = expiracaoEmSegundos(claims?.exp);

  if (
    !claims ||
    typeof claims.sub !== "string" ||
    !claims.sub.trim() ||
    claims.client_id !== clientId ||
    claims.token_use !== "access" ||
    !Number.isFinite(expiracao) ||
    expiracao <= Date.now() / 1000
  ) {
    throw new ErroHttp(
      401,
      "SESSAO_INVALIDA",
      "Sua sessão terminou. Entre novamente.",
    );
  }

  return claims.sub;
}
