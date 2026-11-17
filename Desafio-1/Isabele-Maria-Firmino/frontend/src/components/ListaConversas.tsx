import { useEffect, useState } from 'react'
import { ErroApi, MENSAGEM_PADRAO, listConversas, type ResumoConversa } from '../api.ts'
import type { ConfigApp } from '../config.ts'

type EstadoLista = 'carregando' | 'pronto' | 'erro'

export type ListaConversasProps = {
  config: ConfigApp
  conversaAtual: string
  atualizacao: number
  onSelect: (conversaId: string) => void
  onNova: () => void
}

const FORMATO_DATA = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

export function formatData(iso: string): string {
  const data = new Date(iso)
  return Number.isNaN(data.getTime()) ? '' : FORMATO_DATA.format(data)
}

export default function ListaConversas({ config, conversaAtual, atualizacao, onSelect, onNova }: ListaConversasProps) {
  const [conversas, setConversas] = useState<ResumoConversa[]>([])
  const [estado, setEstado] = useState<EstadoLista>('carregando')
  const [mensagemErro, setMensagemErro] = useState('')
  const [tentativa, setTentativa] = useState(0)

  useEffect(() => {
    let ativo = true
    setEstado('carregando')

    listConversas(config)
      .then((lista) => {
        if (!ativo) return
        setConversas(lista)
        setEstado('pronto')
      })
      .catch((erro: unknown) => {
        if (!ativo) return
        setMensagemErro(erro instanceof ErroApi ? erro.message : MENSAGEM_PADRAO)
        setEstado('erro')
      })

    return () => {
      ativo = false
    }
  }, [config, atualizacao, tentativa])

  return (
    <nav className="lista-conversas" aria-label="Conversas">
      <button type="button" className="botao-nova" onClick={onNova}>
        + Nova conversa
      </button>

      {estado === 'erro' && (
        <div className="lista-erro" role="alert">
          <p>{mensagemErro}</p>
          <button type="button" onClick={() => setTentativa((valor) => valor + 1)}>
            Tentar de novo
          </button>
        </div>
      )}

      {estado === 'carregando' && conversas.length === 0 && <p className="lista-vazia">Carregando…</p>}
      {estado === 'pronto' && conversas.length === 0 && <p className="lista-vazia">Nenhuma conversa ainda.</p>}

      <ul>
        {conversas.map((conversa) => {
          const ativa = conversa.conversa_id === conversaAtual
          return (
            <li key={conversa.conversa_id}>
              <button
                type="button"
                className={ativa ? 'conversa conversa-ativa' : 'conversa'}
                aria-current={ativa ? 'true' : undefined}
                onClick={() => onSelect(conversa.conversa_id)}
              >
                <span className="conversa-titulo">{conversa.titulo}</span>
                <span className="conversa-data">{formatData(conversa.atualizada_em)}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
