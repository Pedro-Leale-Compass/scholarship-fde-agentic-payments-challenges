/**
 * Utilitário de CORS para validação da origem da requisição
 * contra a lista configurada na variável de ambiente ORIGENS_PERMITIDAS (CSV).
 */

export function obterOrigemPermitida(event: { headers?: Record<string, string | undefined> }): string {
  const envOrigens = process.env.ORIGENS_PERMITIDAS || '';
  const origensValidas = envOrigens
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const reqOrigin = event.headers?.origin || event.headers?.Origin || '';

  if (reqOrigin && origensValidas.includes(reqOrigin)) {
    return reqOrigin;
  }

  // Retorna a primeira origem configurada como padrão seguro
  return origensValidas[0] || '';
}

export function cabecalhosCors(event: { headers?: Record<string, string | undefined> }): Record<string, string> {
  const origem = obterOrigemPermitida(event);
  return {
    'Access-Control-Allow-Origin': origem,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Vary': 'Origin',
  };
}
