/**
 * CONTRATO COMPARTILHADO -- fonte da verdade entre tools, api e frontend.
 *
 * Herdado da Fase 1 sem mudar as regras de negocio. O que saiu: login
 * proprio (bcrypt + JWT do backend), substituido pelo Amazon Cognito.
 */

/* ------------------------------------------------------------------ */
/* Dominio de pagamentos                                               */
/* ------------------------------------------------------------------ */

export type MetodoPagamento = "cartao" | "pix";

export const METODOS_PAGAMENTO: readonly MetodoPagamento[] = ["cartao", "pix"];

export interface Produto {
  id: string;
  nome: string;
  descricao: string;
  categoria: string;
  preco: number;
  /** Sempre "BRL" neste desafio. */
  moeda: string;
  estoque: number;
}

export type StatusIntencao = "pendente" | "pago";

export interface Intencao {
  intencao_id: string;
  /** Dono da intencao. Vem do token do Cognito (sub), NUNCA de argumento de tool. */
  user_id: string;
  produto_id: string;
  produto_nome: string;
  quantidade: number;
  /** Calculado no servidor: preco * quantidade. O modelo nao informa valor. */
  valor_total: number;
  moeda: string;
  status: StatusIntencao;
  /** ISO 8601 */
  criada_em: string;
  /** ISO 8601 -- criada_em + TTL */
  expira_em: string;
}

/** Codigos de erro do fluxo de compra, na ordem em que sao validados. */
export type ErroCompra =
  | "INTENCAO_INVALIDA"
  | "INTENCAO_JA_PAGA"
  | "INTENCAO_EXPIRADA"
  | "METODO_INVALIDO"
  | "LIMITE_EXCEDIDO"
  /**
   * Novo na nuvem: o estoque e conferido de novo no pagamento, dentro da
   * transacao do DynamoDB. Com varias instancias concorrentes, o estoque
   * pode acabar entre registrar_intencao e realizar_compra -- na Fase 1
   * (memoria, processo unico) ele simplesmente ficava negativo.
   */
  | "ESTOQUE_INSUFICIENTE";

/** Erros do registrar_intencao (Fase 1). */
export type ErroIntencao = "PRODUTO_INVALIDO" | "ESTOQUE_INSUFICIENTE";

export interface CompraAprovada {
  status: "aprovado";
  transacao_id: string;
  intencao_id: string;
  produto_nome: string;
  quantidade: number;
  valor_debitado: number;
  metodo_pagamento: MetodoPagamento;
  limite_restante: number;
  /** ISO 8601 */
  criada_em: string;
}

export interface CompraRecusada {
  status: "recusado";
  erro: ErroCompra;
  /** Mensagem legivel -- e o que o agente usa para explicar ao usuario. */
  mensagem: string;
}

export type ResultadoCompra = CompraAprovada | CompraRecusada;

export interface Transacao {
  transacao_id: string;
  intencao_id: string;
  user_id: string;
  valor: number;
  metodo_pagamento: MetodoPagamento;
  criada_em: string;
}

/* ------------------------------------------------------------------ */
/* Argumentos das tools                                                */
/* ------------------------------------------------------------------ */

/**
 * IMPORTANTE: nenhuma tool recebe `user_id` do modelo (o agente injeta o
 * sub do Cognito, repassado pela Lambda do chat) e nenhuma recebe `valor`.
 */

export interface ListarCatalogoArgs {
  categoria?: string;
}

export interface RegistrarIntencaoArgs {
  produto_id: string;
  quantidade: number;
}

export interface RealizarCompraArgs {
  intencao_id: string;
  metodo_pagamento: string;
}

export const NOMES_TOOLS = [
  "listar_catalogo",
  "registrar_intencao",
  "realizar_compra",
] as const;

export type NomeTool = (typeof NOMES_TOOLS)[number];

/**
 * Payload que o agente envia para a Lambda de tools.
 * `user_id` e preenchido pelo agente a partir do contexto da requisicao,
 * nunca pelo modelo.
 */
export interface ToolInvocation {
  tool: NomeTool;
  user_id: string;
  args: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Conversa (api <-> frontend)                                         */
/* ------------------------------------------------------------------ */

export interface ToolCall {
  id: string;
  nome: string;
  argumentos: Record<string, unknown>;
  resultado?: unknown;
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ChatRequest {
  mensagem: string;
}

export interface ApiError {
  erro: string;
}
