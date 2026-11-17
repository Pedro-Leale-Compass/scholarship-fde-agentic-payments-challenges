import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import Markdown from 'react-markdown'
import { ErroApi, MENSAGEM_PADRAO, getConversa, streamChat } from '../api.ts'
import {
  addPergunta,
  applyErro,
  applyEvento,
  createMensagensDoHistorico,
  finishResposta,
  isEscrevendo,
  type MensagemTela,
} from '../chat-estado.ts'
import type { ConfigApp } from '../config.ts'
import PainelTools from './PainelTools.tsx'

export const TAMANHO_MAXIMO_MENSAGEM = 2000
export const MENSAGEM_INTERROMPIDA = 'A resposta foi interrompida antes de terminar. Envie a mensagem de novo.'

export type ChatProps = {
  config: ConfigApp
  conversaId: string
  nova: boolean
  onTurnoFinalizado: () => void
  onSessaoExpirada: () => void
}

function isCancelamento(erro: unknown): boolean {
  return erro instanceof DOMException && erro.name === 'AbortError'
}

function getMensagemErro(erro: unknown): string {
  return erro instanceof ErroApi ? erro.message : MENSAGEM_PADRAO
}

function Mensagem({ mensagem }: { mensagem: MensagemTela }) {
  if (mensagem.tipo === 'usuario') {
    return <div className="mensagem mensagem-usuario">{mensagem.texto}</div>
  }
  if (mensagem.tipo === 'aviso') {
    return (
      <div className="mensagem mensagem-aviso" role="alert">
        {mensagem.texto}
      </div>
    )
  }
  return (
    <div className="mensagem mensagem-agente">
      {mensagem.texto && (
        <div className="markdown">
          <Markdown>{mensagem.texto}</Markdown>
        </div>
      )}
      {mensagem.escrevendo && (
        <span className="digitando" aria-label="O agente está respondendo">
          ●●●
        </span>
      )}
      <PainelTools tools={mensagem.tools} />
    </div>
  )
}

export default function Chat({ config, conversaId, nova, onTurnoFinalizado, onSessaoExpirada }: ChatProps) {
  const [mensagens, setMensagens] = useState<MensagemTela[]>([])
  const [texto, setTexto] = useState('')
  const [carregando, setCarregando] = useState(false)
  const controlador = useRef<AbortController | null>(null)
  const fim = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    controlador.current?.abort()
    setMensagens([])
    setTexto('')

    if (nova) {
      setCarregando(false)
      return
    }

    let ativo = true
    setCarregando(true)
    getConversa(config, conversaId)
      .then((conversa) => {
        if (ativo) setMensagens(createMensagensDoHistorico(conversa.historico))
      })
      .catch((erro: unknown) => {
        if (!ativo) return
        if (erro instanceof ErroApi && erro.status === 401) onSessaoExpirada()
        setMensagens(applyErro([], getMensagemErro(erro)))
      })
      .finally(() => {
        if (ativo) setCarregando(false)
      })

    return () => {
      ativo = false
    }
  }, [config, conversaId, nova])

  useEffect(() => {
    fim.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [mensagens])

  useEffect(() => () => controlador.current?.abort(), [])

  async function sendMensagem(): Promise<void> {
    const pergunta = texto.trim()
    if (!pergunta || carregando || isEscrevendo(mensagens)) return

    setTexto('')
    setMensagens((lista) => addPergunta(lista, pergunta))

    const atual = new AbortController()
    controlador.current = atual
    let recebeuFim = false
    let recebeuErro = false

    try {
      for await (const evento of streamChat(config, conversaId, pergunta, atual.signal)) {
        if (atual.signal.aborted) return
        if (evento.tipo === 'fim') recebeuFim = true
        if (evento.tipo === 'erro') recebeuErro = true
        setMensagens((lista) => applyEvento(lista, evento))
      }
      if (recebeuFim) onTurnoFinalizado()
      else if (!recebeuErro) setMensagens((lista) => applyErro(lista, MENSAGEM_INTERROMPIDA))
    } catch (erro) {
      if (atual.signal.aborted || isCancelamento(erro)) {
        setMensagens((lista) => finishResposta(lista))
        return
      }
      setMensagens((lista) => applyErro(lista, getMensagemErro(erro)))
      if (erro instanceof ErroApi && erro.status === 401) onSessaoExpirada()
    } finally {
      if (controlador.current === atual) controlador.current = null
    }
  }

  function handleSubmit(evento: FormEvent<HTMLFormElement>): void {
    evento.preventDefault()
    void sendMensagem()
  }

  function handleKeyDown(evento: KeyboardEvent<HTMLTextAreaElement>): void {
    if (evento.key === 'Enter' && !evento.shiftKey && !evento.nativeEvent.isComposing) {
      evento.preventDefault()
      void sendMensagem()
    }
  }

  const ocupado = carregando || isEscrevendo(mensagens)

  return (
    <section className="chat" aria-label="Chat com o agente">
      <div className="mensagens" aria-live="polite">
        {carregando && <p className="chat-status">Carregando conversa…</p>}
        {!carregando && mensagens.length === 0 && (
          <div className="chat-boas-vindas">
            <h2>Olá!</h2>
            <p>Pergunte o que temos à venda, escolha um produto e pague com cartão ou Pix.</p>
          </div>
        )}
        {mensagens.map((mensagem) => (
          <Mensagem key={mensagem.id} mensagem={mensagem} />
        ))}
        <div ref={fim} />
      </div>

      <form className="chat-form" onSubmit={handleSubmit}>
        <textarea
          value={texto}
          onChange={(evento) => setTexto(evento.target.value)}
          onKeyDown={handleKeyDown}
          maxLength={TAMANHO_MAXIMO_MENSAGEM}
          rows={2}
          placeholder="Digite sua mensagem… (Enter envia, Shift+Enter quebra a linha)"
          aria-label="Mensagem"
          disabled={carregando}
        />
        <div className="chat-form-rodape">
          <span className="contador">
            {texto.length}/{TAMANHO_MAXIMO_MENSAGEM}
          </span>
          <button type="submit" disabled={ocupado || !texto.trim()}>
            Enviar
          </button>
        </div>
      </form>
    </section>
  )
}
