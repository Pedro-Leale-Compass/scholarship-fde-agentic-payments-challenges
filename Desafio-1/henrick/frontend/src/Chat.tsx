import { useEffect, useRef, useState } from "react";
import { enviarMensagem } from "./api.js";

interface Mensagem {
  role: "user" | "assistant";
  content: string;
}

interface Props {
  nome: string;
  aoSair: () => void;
}

export default function Chat({ nome, aoSair }: Props) {
  const [mensagens, setMensagens] = useState<Mensagem[]>([]);
  const [input, setInput] = useState("");
  const [aguardando, setAguardando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [mensagens, aguardando]);

  function acrescentarNaResposta(pedaco: string) {
    setMensagens(prev => {
      const copia = [...prev];
      const ultima = copia[copia.length - 1];
      copia[copia.length - 1] = { ...ultima, content: ultima.content + pedaco };
      return copia;
    });
  }

  async function enviar() {
    const texto = input.trim();
    if (!texto || aguardando) return;

    setMensagens(prev => [...prev, { role: "user", content: texto }, { role: "assistant", content: "" }]);
    setInput("");
    setErro(null);
    setAguardando(true);

    try {
      await enviarMensagem(texto, acrescentarNaResposta);
    } catch (err: unknown) {
      setErro((err as { message?: string }).message ?? "Erro ao comunicar com o agente.");
      setMensagens(prev => (prev[prev.length - 1]?.content === "" ? prev.slice(0, -1) : prev));
    } finally {
      setAguardando(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      enviar();
    }
  }

  const ultima = mensagens[mensagens.length - 1];
  const esperandoPrimeiroPedaco = aguardando && ultima?.role === "assistant" && ultima.content === "";

  return (
    <div className="chat-page">
      <header className="chat-header">
        <div className="chat-header-brand">
          <div className="chat-header-icon" aria-hidden="true">🤖</div>
          <div>
            <div className="chat-header-title">Agente de Pagamentos</div>
            <div className="chat-header-sub">Bedrock · AgentCore</div>
          </div>
        </div>
        <div className="chat-header-user">
          <span className="chat-header-name" aria-label={`Logado como ${nome}`}>{nome}</span>
          <button className="btn-logout" onClick={aoSair} aria-label="Sair da conta">
            Sair
          </button>
        </div>
      </header>

      <div ref={listRef} className="chat-messages" role="log" aria-label="Conversa" aria-live="polite">
        {mensagens.length === 0 && (
          <div className="chat-empty">
            <h2>Ola!</h2>
            <p>Pergunte o que temos a venda ou diga o que quer comprar.</p>
          </div>
        )}

        {mensagens.map((msg, i) =>
          msg.content ? (
            <div key={i} className={`msg-row ${msg.role}`}>
              <div className="msg-bubble">
                <span style={{ whiteSpace: "pre-wrap" }}>{msg.content}</span>
              </div>
            </div>
          ) : null,
        )}

        {esperandoPrimeiroPedaco && (
          <div className="msg-row assistant" aria-label="Agente digitando…">
            <div className="typing-indicator" aria-hidden="true">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </div>
          </div>
        )}

        {erro && (
          <div className="msg-row assistant" role="alert">
            <div className="msg-bubble" style={{ borderColor: "rgba(239,68,68,0.4)", color: "#FCA5A5" }}>
              ⚠️ {erro}
            </div>
          </div>
        )}
      </div>

      <form className="chat-input-area" onSubmit={e => { e.preventDefault(); enviar(); }} aria-label="Enviar mensagem">
        <div className="chat-input-row">
          <textarea
            ref={inputRef}
            className="chat-input"
            placeholder="Digite uma mensagem… (Enter para enviar)"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={aguardando}
            rows={1}
            aria-label="Campo de mensagem"
            autoFocus
          />
          <button type="submit" className="btn-send" disabled={aguardando || !input.trim()} aria-label="Enviar">
            ➤
          </button>
        </div>
        <p className="chat-input-hint">Enter para enviar · Shift+Enter para nova linha</p>
      </form>
    </div>
  );
}