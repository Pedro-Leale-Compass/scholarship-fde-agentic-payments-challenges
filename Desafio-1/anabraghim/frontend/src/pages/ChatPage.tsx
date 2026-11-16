import { useCallback, useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { NaoAutenticadoError, buscarConversas, buscarPerfil, enviarMensagem } from "../lib/api"
import {
    ESTADO_INICIAL,
    adicionarUsuario,
    aplicarEvento,
    historicoParaTela,
    rotuloFerramenta,
    type EstadoConversa,
} from "../lib/conversa"
import { obterTokenId } from "../lib/sessao"
import type { Perfil } from "../types"
import "./Chat.css"

const CLASSE_DO_PAPEL = { usuario: "bubble-user", assistente: "bubble-assistant", erro: "bubble-erro" } as const

function formatarReais(valor: number): string {
    return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
}

let contador = 0
const novoId = () => `m${++contador}`

interface Props {
    onSair: () => void
}

function ChatPage({ onSair }: Props) {
    const [conversa, setConversa] = useState<EstadoConversa>(ESTADO_INICIAL)
    const [input, setInput] = useState("")
    const [enviando, setEnviando] = useState(false)
    const [carregando, setCarregando] = useState(true)
    const [avisoHistorico, setAvisoHistorico] = useState<string | null>(null)
    const [perfil, setPerfil] = useState<Perfil | null>(null)
    const fimDaLista = useRef<HTMLDivElement>(null)

    // Qualquer 401 (token expirado e não renovável, usuário desativado) encerra a sessão.
    const tratarErro = useCallback(
        (erro: unknown): string | null => {
            if (erro instanceof NaoAutenticadoError) {
                onSair()
                return null
            }
            return erro instanceof Error ? erro.message : "Erro inesperado."
        },
        [onSair]
    )

    const atualizarPerfil = useCallback(async () => {
        try {
            setPerfil(await buscarPerfil(await obterTokenId()))
        } catch (erro) {
            tratarErro(erro) // o perfil é só o cabeçalho: falha não bloqueia o chat
        }
    }, [tratarErro])

    useEffect(() => {
        let ativo = true
        ;(async () => {
            try {
                const token = await obterTokenId()
                atualizarPerfil()
                const historico = await buscarConversas(token)
                if (ativo) setConversa({ ...ESTADO_INICIAL, mensagens: historicoParaTela(historico, novoId) })
            } catch (erro) {
                const mensagem = tratarErro(erro)
                if (ativo && mensagem) setAvisoHistorico("Não foi possível carregar o histórico. " + mensagem)
            } finally {
                if (ativo) setCarregando(false)
            }
        })()
        return () => {
            ativo = false
        }
    }, [atualizarPerfil, tratarErro])

    useEffect(() => {
        fimDaLista.current?.scrollIntoView({ behavior: "smooth", block: "end" })
    }, [conversa.mensagens])

    async function enviar() {
        const texto = input.trim()
        if (!texto || enviando || carregando) return

        setInput("")
        setEnviando(true)
        setConversa((estado) => adicionarUsuario(estado, texto, novoId()))
        try {
            const token = await obterTokenId()
            for await (const evento of enviarMensagem(texto, token)) {
                setConversa((estado) => aplicarEvento(estado, evento, novoId))
                // O limite muda quando o turno conclui uma compra.
                if (evento.tipo === "fim") atualizarPerfil()
            }
        } catch (erro) {
            const mensagem = tratarErro(erro)
            if (mensagem) setConversa((estado) => aplicarEvento(estado, { tipo: "erro", mensagem }, novoId))
        } finally {
            setEnviando(false)
        }
    }

    const ultima = conversa.mensagens.at(-1)
    const aguardando = enviando && (conversa.ferramenta !== null || ultima?.papel === "usuario")

    return (
        <div className="chat-page">
            <header className="chat-header">
                <span className="brand">◈ assistente de compras</span>
                <div className="chat-header-right">
                    {perfil && (
                        <span className="limit-pill" title={`Limite total: ${formatarReais(perfil.limite_total)}`}>
                            limite disponível: {formatarReais(perfil.limite_disponivel)}
                        </span>
                    )}
                    {perfil?.email && <span className="username">{perfil.email}</span>}
                    <button className="logout-btn" onClick={onSair}>
                        Sair
                    </button>
                </div>
            </header>

            <div className="chat-messages" aria-live="polite">
                {carregando && <div className="chat-aviso">Carregando a conversa…</div>}
                {avisoHistorico && <div className="chat-aviso">{avisoHistorico}</div>}
                {!carregando && conversa.mensagens.length === 0 && !avisoHistorico && (
                    <div className="chat-aviso">Pergunte o que temos à venda para começar.</div>
                )}
                {conversa.mensagens.map((m) => (
                    <div key={m.id} className={`bubble ${CLASSE_DO_PAPEL[m.papel]}`}>
                        {m.papel === "erro" ? (
                            m.texto
                        ) : (
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.texto}</ReactMarkdown>
                        )}
                    </div>
                ))}
                {aguardando && (
                    <div className="bubble bubble-assistant bubble-status">
                        {conversa.ferramenta ? `🔧 ${rotuloFerramenta(conversa.ferramenta)}` : "…"}
                    </div>
                )}
                <div ref={fimDaLista} />
            </div>

            <form
                className="chat-input"
                onSubmit={(e) => {
                    e.preventDefault()
                    enviar()
                }}
            >
                <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Pergunte o que temos à venda…"
                    maxLength={4000}
                    disabled={enviando || carregando}
                    aria-label="Mensagem"
                />
                <button type="submit" disabled={enviando || carregando || input.trim() === ""}>
                    Enviar
                </button>
            </form>
        </div>
    )
}

export default ChatPage
