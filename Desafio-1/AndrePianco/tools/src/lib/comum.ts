import { randomBytes } from "node:crypto";

/**
 * Evento que o agente envia para cada Lambda de tool.
 *
 * `user_id` e preenchido pelo AGENTE a partir do contexto da requisicao
 * (o sub do Cognito repassado pela Lambda do chat). O modelo so preenche
 * `args`. Quem pode invocar estas Lambdas e apenas a role do AgentCore.
 */
export interface EventoTool<A> {
  user_id: string;
  args: A;
}

/** Erro de entrada: o modelo mandou argumento fora do contrato. */
export class ArgumentoInvalido extends Error {}

export function exigirUsuario(evento: { user_id?: unknown }): string {
  if (typeof evento?.user_id !== "string" || evento.user_id.trim() === "") {
    throw new ArgumentoInvalido("Requisicao sem usuario autenticado.");
  }
  return evento.user_id;
}

/** Gera `int_a1b2c3` ou `tx_9f0e11` -- mesmo formato da Fase 1. */
export function idAleatorio(prefixo: "int" | "tx"): string {
  return `${prefixo}_${randomBytes(3).toString("hex")}`;
}

/** Arredonda para centavos -- evita sobras de ponto flutuante (0.1+0.2). */
export function centavos(valor: number): number {
  return Math.round(valor * 100) / 100;
}

/** Registro de auditoria no CloudWatch (substitui o audit.log da Fase 1). */
export function auditar(registro: {
  user_id: string;
  tool: string;
  args: unknown;
  resultado: unknown;
}): void {
  console.log(JSON.stringify({ tipo: "auditoria", em: new Date().toISOString(), ...registro }));
}

/**
 * Envolve o handler: qualquer falha vira uma mensagem legivel para o
 * agente, nunca um stack trace. O detalhe tecnico fica so no log.
 */
export function comTratamento<E, R>(
  tool: string,
  fn: (evento: E) => Promise<R>,
): (evento: E) => Promise<R | { erro: string; mensagem: string }> {
  return async (evento: E) => {
    try {
      return await fn(evento);
    } catch (e) {
      if (e instanceof ArgumentoInvalido) {
        return { erro: "ARGUMENTO_INVALIDO", mensagem: e.message };
      }
      console.error(JSON.stringify({ tipo: "falha_tool", tool, erro: String(e), stack: (e as Error)?.stack }));
      return {
        erro: "FALHA_INTERNA",
        mensagem: "Nao foi possivel concluir a operacao agora. Tente novamente em instantes.",
      };
    }
  };
}
