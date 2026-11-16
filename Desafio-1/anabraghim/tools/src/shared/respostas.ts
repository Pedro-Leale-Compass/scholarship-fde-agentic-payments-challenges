// Formato de recusa da Fase 1, mantido: a `mensagem` é o texto que o agente
// explica ao usuário em linguagem natural.
export interface Recusa {
    status: "recusado"
    erro: CodigoErro
    mensagem: string
}

export type CodigoErro =
    | "INTENCAO_INVALIDA"
    | "INTENCAO_EXPIRADA"
    | "INTENCAO_JA_PAGA"
    | "LIMITE_EXCEDIDO"
    | "METODO_INVALIDO"
    | "PRODUTO_NAO_ENCONTRADO"
    | "ESTOQUE_INSUFICIENTE"
    | "QUANTIDADE_INVALIDA"
    | "FALHA_NA_FERRAMENTA"

export function recusar(erro: CodigoErro, mensagem: string): Recusa {
    return { status: "recusado", erro, mensagem }
}
