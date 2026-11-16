import type { PedidoAtual } from "../types";

export interface MensagemStrands {
  role: "user" | "assistant";
  content: Record<string, unknown>[];
  tracking_id?: string;
  [campo: string]: unknown;
}

export interface ResumoConversa {
  conversa_id: string;
  estado: "livre" | "processando" | "incerta";
  versao: number;
  criada_em: string;
  atualizada_em: string;
  requisicao_id: string | null;
}

export interface ConsultaRequisicao {
  requisicao_id: string;
  estado: "nao_recebida" | "processando" | "incerta" | "concluida";
  versao: number | null;
}

export interface Conversa extends ResumoConversa {
  historico: MensagemStrands[];
  requisicao: ConsultaRequisicao | null;
}

export interface PendenciaChat {
  conversa_id: string;
  requisicao_id: string;
  mensagem: string;
}

export interface ResultadoChat {
  tipo: "fim";
  conversa_id: string;
  requisicao_id: string;
  versao: number;
  resposta: string;
  historico: MensagemStrands[];
  repetida: boolean;
}

export type EventoChat =
  | {
      tipo: "inicio";
      conversa_id: string;
      requisicao_id: string;
      repetida: boolean;
    }
  | { tipo: "delta"; texto: string }
  | {
      tipo: "mensagem";
      sequencia: number;
      mensagem: MensagemStrands;
    }
  | ResultadoChat;

export type PedidoChat = PedidoAtual & {
  expiraEm?: string;
  codigoErro?: string;
  transacaoId?: string;
};

export function registro(
  valor: unknown,
): Record<string, unknown> | null {
  return valor !== null &&
    typeof valor === "object" &&
    !Array.isArray(valor)
    ? valor as Record<string, unknown>
    : null;
}

export function ehMensagemStrands(
  valor: unknown,
): valor is MensagemStrands {
  const item = registro(valor);

  return !!item &&
    ["user", "assistant"].includes(String(item.role)) &&
    Array.isArray(item.content) &&
    item.content.every((parte) => registro(parte) !== null);
}
