// gemini-chat/src/types.ts
type ParteMensagem =
  | { text: string }
  | {
      functionCall: {
        name: string;
        args: Record<string, unknown>;
      };
    }
  | {
      functionResponse: {
        name: string;
        response: {
          name: string;
          content: unknown;
        };
      };
    };

interface Content {
  role: "user" | "model";
  parts: ParteMensagem[];
}

export interface Usuario {
  id: string;
  username: string;
  limiteGasto: number;
}

export interface MensagemUI {
  id: string;
  role: "user" | "model";
  texto: string;
}

export interface EventoCatalogo {
  id: string;
  nome: string;
  preco: number;
  moeda: string;
  estoque: number;
}

export interface PedidoAtual {
  intencaoId?: string;
  eventoId: string;
  nome: string;
  quantidade: number;
  valorTotal: number;
  moeda: string;
  status: "pendente" | "aprovado" | "recusado";
  metodoPagamento?: "cartao" | "pix";
  mensagemErro?: string;
}

export interface RespostaChat {
  resposta: string;
  historico: Content[];
  iteracoes: number;
}

export type { Content };
