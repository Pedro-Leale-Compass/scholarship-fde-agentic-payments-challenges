import type { EventoTool } from './contexto.ts'

export type Recusa<E extends string> = { status: 'recusado'; erro: E; mensagem: string }

export function createRecusa<E extends string>(erro: E, mensagem: string): Recusa<E> {
  return { status: 'recusado', erro, mensagem }
}

export const ERRO_INTERNO = {
  status: 'erro',
  erro: 'ERRO_INTERNO',
  mensagem: 'Não foi possível concluir a operação agora. Tente novamente em instantes.',
} as const

export function createHandler<R>(tool: string, corpo: (evento: EventoTool) => Promise<R>) {
  return async (evento: EventoTool | null | undefined): Promise<R | typeof ERRO_INTERNO> => {
    try {
      return await corpo(evento ?? {})
    } catch (erro) {
      console.error(
        JSON.stringify({
          tool,
          erro: erro instanceof Error ? { nome: erro.name, mensagem: erro.message } : String(erro),
        }),
      )
      return ERRO_INTERNO
    }
  }
}
