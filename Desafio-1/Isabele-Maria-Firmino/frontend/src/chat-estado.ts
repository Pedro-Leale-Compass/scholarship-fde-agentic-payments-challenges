import type { EventoChat, ItemHistorico, ToolExecutada } from './api.ts'

export type MensagemTela =
  | { id: string; tipo: 'usuario'; texto: string }
  | { id: string; tipo: 'agente'; texto: string; tools: ToolExecutada[]; escrevendo: boolean }
  | { id: string; tipo: 'aviso'; texto: string }

export type RespostaAgente = Extract<MensagemTela, { tipo: 'agente' }>

export function createId(): string {
  return crypto.randomUUID()
}

export function createMensagensDoHistorico(historico: ItemHistorico[]): MensagemTela[] {
  return historico.map((item) =>
    item.tipo === 'usuario'
      ? { id: createId(), tipo: 'usuario', texto: item.texto }
      : { id: createId(), tipo: 'agente', texto: item.texto, tools: item.tools, escrevendo: false },
  )
}

export function addPergunta(mensagens: MensagemTela[], texto: string): MensagemTela[] {
  return [
    ...mensagens,
    { id: createId(), tipo: 'usuario', texto },
    { id: createId(), tipo: 'agente', texto: '', tools: [], escrevendo: true },
  ]
}

function updateRespostaAtual(
  mensagens: MensagemTela[],
  alterar: (resposta: RespostaAgente) => RespostaAgente | undefined,
): MensagemTela[] {
  const indice = mensagens.findLastIndex((mensagem) => mensagem.tipo === 'agente' && mensagem.escrevendo)
  if (indice === -1) return mensagens

  const alterada = alterar(mensagens[indice] as RespostaAgente)
  const copia = [...mensagens]
  if (alterada) copia[indice] = alterada
  else copia.splice(indice, 1)
  return copia
}

export function finishResposta(mensagens: MensagemTela[]): MensagemTela[] {
  return updateRespostaAtual(mensagens, (resposta) =>
    resposta.texto || resposta.tools.length > 0 ? { ...resposta, escrevendo: false } : undefined,
  )
}

export function applyErro(mensagens: MensagemTela[], texto: string): MensagemTela[] {
  return [...finishResposta(mensagens), { id: createId(), tipo: 'aviso', texto }]
}

export function applyEvento(mensagens: MensagemTela[], evento: EventoChat): MensagemTela[] {
  switch (evento.tipo) {
    case 'texto':
      return updateRespostaAtual(mensagens, (resposta) => ({ ...resposta, texto: resposta.texto + evento.texto }))
    case 'tool':
      return updateRespostaAtual(mensagens, (resposta) => ({
        ...resposta,
        tools: [...resposta.tools, { nome: evento.nome, argumentos: evento.argumentos, resultado: evento.resultado }],
      }))
    case 'erro':
      return applyErro(mensagens, evento.mensagem)
    case 'fim':
      return finishResposta(mensagens)
  }
}

export function isEscrevendo(mensagens: MensagemTela[]): boolean {
  return mensagens.some((mensagem) => mensagem.tipo === 'agente' && mensagem.escrevendo)
}
