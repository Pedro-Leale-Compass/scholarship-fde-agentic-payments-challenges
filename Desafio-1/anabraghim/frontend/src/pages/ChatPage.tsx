import { useCallback, useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { IconeBrilho, IconeEnviar, IconeFerramenta, IconeSacola, IconeSair } from "../components/Icones"
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
const CLASSE_DA_LINHA = { usuario: "msg-user", assistente: "msg-assistant", erro: "msg-erro" } as const

// Atalhos da tela de boas-vindas: um clique envia a frase como mensagem.
const SUGESTOES = ["O que vocês têm à venda?", "Quero um fone Bluetooth", "Me mostra os periféricos"]

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

    async function enviar(sugestao?: string) {
        const texto = (sugestao ?? input).trim()
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

    const vazia = !carregando && conversa.mensagens.length === 0 && !avisoHistorico

    return (
        <div className="chat-page">
            <header className="chat-header">
                <div className="brand">
                    <span className="logo">
                        <IconeSacola />
                    </span>
                    <div className="brand-texto">
                        <span className="brand-nome">Assistente de Compras</span>
                        <span className="brand-status">online</span>
                    </div>
                </div>
                <div className="chat-header-right">
                    {perfil && (
                        <span className="limit-pill" title={`Limite total: ${formatarReais(perfil.limite_total)}`}>
                            <small>limite</small>
                            <strong>{formatarReais(perfil.limite_disponivel)}</strong>
                        </span>
                    )}
                    {perfil?.email && (
                        <span className="avatar" title={perfil.email}>
                            {perfil.email.charAt(0)}
                        </span>
                    )}
                    <button className="icon-btn" onClick={onSair} title="Sair" aria-label="Sair">
                        <IconeSair />
                    </button>
                </div>
            </header>

            <div className="chat-messages" aria-live="polite">
                {carregando && <div className="chat-aviso">Carregando a conversa…</div>}
                {avisoHistorico && <div className="chat-aviso">{avisoHistorico}</div>}
                {vazia && (
                    <div className="boas-vindas">
                        <span className="logo logo-lg">
                            <IconeSacola tamanho={28} />
                        </span>
                        <h1>
                            Oi! Bora às <span>compras</span>?
                        </h1>
                        <p>Pergunte sobre os produtos, escolha o que quiser e pague com cartão ou Pix, tudo pelo chat.</p>
                        <div className="sugestoes">
                            {SUGESTOES.map((s) => (
                                <button key={s} type="button" className="sugestao" onClick={() => enviar(s)}>
                                    {s}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
                {conversa.mensagens.map((m) => (
                    <div key={m.id} className={`msg ${CLASSE_DA_LINHA[m.papel]}`}>
                        {m.papel === "assistente" && (
                            <span className="bot-avatar">
                                <IconeBrilho />
                            </span>
                        )}
                        <div className={`bubble ${CLASSE_DO_PAPEL[m.papel]}`}>
                            {m.papel === "erro" ? (
                                m.texto
                            ) : (
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.texto}</ReactMarkdown>
                            )}
                        </div>
                    </div>
                ))}
                {aguardando && (
                    <div className="msg msg-assistant">
                        <span className="bot-avatar">
                            <IconeBrilho />
                        </span>
                        <div className="bubble bubble-assistant bubble-status">
                            {conversa.ferramenta ? (
                                <>
                                    <IconeFerramenta /> {rotuloFerramenta(conversa.ferramenta)}
                                </>
                            ) : (
                                <span className="digitando" aria-label="O assistente está digitando">
                                    <span />
                                    <span />
                                    <span />
                                </span>
                            )}
                        </div>
                    </div>
                )}
                <div ref={fimDaLista} />
            </div>

            <div className="chat-rodape">
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
                        placeholder="Escreva sua mensagem…"
                        maxLength={4000}
                        disabled={enviando || carregando}
                        aria-label="Mensagem"
                    />
                    <button
                        type="submit"
                        className="enviar-btn"
                        disabled={enviando || carregando || input.trim() === ""}
                        aria-label="Enviar"
                        title="Enviar"
                    >
                        <IconeEnviar />
                    </button>
                </form>
                <p className="aviso-simulado">Ambiente de demonstração: os pagamentos são simulados e nada é cobrado.</p>
            </div>
        </div>
    )
}

export default ChatPage
