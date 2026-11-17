import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { apagarHistorico, cabecalhosCors, carregarHistorico, usuarioDoToken } from "./comum.js";

/**
 * GET /conversas    -> historico do usuario autenticado (para recarregar a tela)
 * DELETE /conversas -> apaga o historico (botao "nova conversa")
 *
 * So acessa a tabela de conversas, sempre filtrando pelo sub do token.
 */
export async function handler(evento: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const headers = { "Content-Type": "application/json", ...cabecalhosCors(evento) };
  const userId = usuarioDoToken(evento);
  if (!userId) return { statusCode: 401, headers, body: JSON.stringify({ erro: "Nao autenticado." }) };

  try {
    if (evento.httpMethod === "DELETE") {
      const apagadas = await apagarHistorico(userId);
      return { statusCode: 200, headers, body: JSON.stringify({ apagadas }) };
    }
    const mensagens = await carregarHistorico(userId);
    return { statusCode: 200, headers, body: JSON.stringify({ mensagens }) };
  } catch (e) {
    console.error(JSON.stringify({ tipo: "falha_conversas", erro: String(e), stack: (e as Error)?.stack }));
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ erro: "Nao foi possivel carregar a conversa agora. Tente novamente." }),
    };
  }
}
