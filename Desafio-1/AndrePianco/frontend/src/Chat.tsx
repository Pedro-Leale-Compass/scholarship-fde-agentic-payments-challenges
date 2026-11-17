import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  apagarHistorico,
  carregarHistorico,
  enviarMensagem,
  ErroApi,
  type EventoChat,
  type MensagemConverse,
} from "./api.js";

interface Props {
  nome: string;
  aoSair: () => void;
}

interface ToolNaTela {
  id: string;
  nome: string;
  argumentos: Record<string, unknown>;
  resultado?: unknown;
}

/** Um balao na tela. Um turno do assistente vira um unico balao. */
interface Item {
  role: "user" | "assistant";
  texto: string;
  tools: ToolNaTela[];
  erro?: string;
  /** Depois de uma tool, o proximo texto comeca em paragrafo novo. */
  quebrar?: boolean;
}

export default function Chat({ nome, aoSair }: Props) {
  const [itens, setItens] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [aguardando, setAguardando] = useState(false);
  const [carregando, setCarregando] = useState(true);
  const [aviso, setAviso] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Recarrega a conversa salva no DynamoDB ao abrir a tela.
  useEffect(() => {
    carregarHistorico()
      .then((mensagens) => setItens(paraItens(mensagens)))
      .catch((e) => tratarErro(e))
      .finally(() => setCarregando(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [itens, aguardando]);

  function tratarErro(e: unknown) {
    if (e instanceof ErroApi && e.status === 401) {
      aoSair();
      return;
    }
    setAviso(e instanceof Error ? e.message : "Erro ao comunicar com o servidor.");
  }

  /** Aplica um evento do stream no ultimo balao (o do assistente). */
  function aplicar(ev: EventoChat) {
    setItens((atual) => {
      const copia = [...atual];
      const ultimo = { ...copia[copia.length - 1]!, tools: [...copia[copia.length - 1]!.tools] };
      if (ev.tipo === "texto") {
        const delta = ultimo.texto ? ev.delta : ev.delta.trimStart();
        if (ultimo.quebrar && ultimo.texto.trim() && delta.trim()) ultimo.texto = ultimo.texto.trimEnd() + "\n\n";
        if (delta.trim()) ultimo.quebrar = false;
        ultimo.texto += delta;
      } else if (ev.tipo === "tool_chamada") {
        ultimo.tools.push({ id: ev.id, nome: ev.nome, argumentos: ev.argumentos });
        ultimo.quebrar = true;
      }
      else if (ev.tipo === "tool_resultado")
        ultimo.tools = ultimo.tools.map((t) => (t.id === ev.id ? { ...t, resultado: ev.resultado } : t));
      else if (ev.tipo === "erro") ultimo.erro = ev.mensagem;
      copia[copia.length - 1] = ultimo;
      return copia;
    });
  }

  async function enviar() {
    const texto = input.trim();
    if (!texto || aguardando) return;

    setItens((atual) => [
      ...atual,
      { role: "user", texto, tools: [] },
      { role: "assistant", texto: "", tools: [] },
    ]);
    setInput("");
    setAviso(null);
    setAguardando(true);

    try {
      await enviarMensagem(texto, aplicar);
    } catch (e) {
      aplicar({ tipo: "erro", mensagem: e instanceof Error ? e.message : "Falha ao enviar a mensagem." });
      tratarErro(e);
    } finally {
      setAguardando(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  async function novaConversa() {
    if (aguardando) return;
    try {
      await apagarHistorico();
      setItens([]);
      setAviso(null);
    } catch (e) {
      tratarErro(e);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      enviar();
    }
  }

  const ultimo = itens[itens.length - 1];
  const digitando = aguardando && ultimo?.role === "assistant" && !ultimo.texto.trim() && ultimo.tools.length === 0;

  return (
    <div className="chat-page">
      <header className="chat-header">
        <div className="chat-header-brand">
          <div className="chat-header-icon" aria-hidden="true">🛍️</div>
          <div>
            <div className="chat-header-title">Assistente de Compras</div>
            <div className="chat-header-sub">Agente na AWS · Bedrock AgentCore</div>
          </div>
        </div>
        <div className="chat-header-user">
          <span className="chat-header-name" aria-label={`Logado como ${nome}`}>{nome}</span>
          <button className="btn-logout" onClick={novaConversa} disabled={aguardando} type="button">
            Nova conversa
          </button>
          <button id="btn-logout" className="btn-logout" onClick={aoSair} aria-label="Sair da conta" type="button">
            Sair
          </button>
        </div>
      </header>

      <div ref={listRef} className="chat-messages" role="log" aria-label="Conversa" aria-live="polite">
        {carregando && <div className="chat-empty"><p>Carregando conversa…</p></div>}

        {!carregando && itens.length === 0 && (
          <div className="chat-empty">
            <h2>Olá!</h2>
            <p>Pergunte o que temos à venda ou diga o que quer comprar.</p>
          </div>
        )}

        {itens.map((item, i) =>
          item.role === "assistant" && !item.texto.trim() && item.tools.length === 0 && !item.erro ? null : (
            <div key={i} className={`msg-row ${item.role}`}>
              <div className="msg-bubble">
                {item.tools.length > 0 && (
                  <div className="tool-calls-block" aria-label="Ferramentas chamadas">
                    {item.tools.map((t) => <ToolChip key={t.id} tool={t} />)}
                  </div>
                )}
                {item.texto && <span>{item.role === "assistant" ? formatar(item.texto) : item.texto}</span>}
                {item.erro && <div className="msg-erro" role="alert">⚠️ {item.erro}</div>}
              </div>
            </div>
          ),
        )}

        {digitando && (
          <div className="msg-row assistant" aria-label="Assistente digitando…">
            <div className="typing-indicator" aria-hidden="true">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </div>
          </div>
        )}

        {aviso && (
          <div className="msg-row assistant" role="alert">
            <div className="msg-bubble"><div className="msg-erro">⚠️ {aviso}</div></div>
          </div>
        )}
      </div>

      <form className="chat-input-area" onSubmit={(e) => { e.preventDefault(); enviar(); }} aria-label="Enviar mensagem">
        <div className="chat-input-row">
          <textarea
            ref={inputRef}
            id="chat-input"
            className="chat-input"
            placeholder="Digite uma mensagem… (Enter para enviar)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={aguardando || carregando}
            maxLength={2000}
            rows={1}
            aria-label="Campo de mensagem"
            autoFocus
          />
          <button id="btn-enviar" type="submit" className="btn-send" disabled={aguardando || !input.trim()} aria-label="Enviar">
            ➤
          </button>
        </div>
        <p className="chat-input-hint">Enter para enviar · Shift+Enter para nova linha</p>
      </form>
    </div>
  );
}

function ToolChip({ tool }: { tool: ToolNaTela }) {
  const [expandido, setExpandido] = useState(false);
  const status = statusDaTool(tool);
  const icone = tool.resultado === undefined ? "⏳" : status === "err" ? "❌" : "✅";

  return (
    <div className="tool-chip" data-tool={tool.nome} {...(status ? { "data-status": status } : {})}>
      <button
        className="tool-chip-header"
        onClick={() => setExpandido((v) => !v)}
        aria-expanded={expandido}
        aria-controls={`chip-${tool.id}`}
        type="button"
      >
        <span aria-hidden="true">🔧</span>
        <span>{tool.nome}</span>
        <span className="tool-chip-status">{icone}</span>
        <span aria-hidden="true" style={{ fontSize: "10px", marginLeft: 2 }}>{expandido ? "▲" : "▼"}</span>
      </button>
      {expandido && (
        <div className="tool-chip-body" id={`chip-${tool.id}`}>
          <p className="tool-section-label">Argumentos</p>
          <pre className="tool-json">{JSON.stringify(tool.argumentos, null, 2)}</pre>
          {tool.resultado !== undefined && (
            <>
              <p className="tool-section-label">Resultado</p>
              <pre className="tool-json">
                {typeof tool.resultado === "string" ? tool.resultado : JSON.stringify(tool.resultado, null, 2)}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Verde para compra aprovada; vermelho para qualquer recusa ou erro. */
function statusDaTool(tool: ToolNaTela): "ok" | "err" | undefined {
  const r = tool.resultado as { status?: string; erro?: string } | undefined;
  if (!r || typeof r !== "object") return undefined;
  if (r.status === "recusado" || r.erro) return "err";
  if (r.status === "aprovado") return "ok";
  return undefined;
}

/** Markdown minimo: **negrito**. Sem innerHTML, sem risco de injecao. */
function formatar(texto: string): ReactNode[] {
  return texto.split(/(\*\*[^*]+\*\*)/g).map((parte, i) =>
    parte.startsWith("**") && parte.endsWith("**") ? <strong key={i}>{parte.slice(2, -2)}</strong> : parte,
  );
}

/** Converte o historico salvo (formato Converse) nos baloes da tela. */
function paraItens(mensagens: MensagemConverse[]): Item[] {
  const itens: Item[] = [];
  for (const m of mensagens) {
    const textos = m.content.filter((b) => b.text).map((b) => b.text!);
    if (m.role === "user") {
      const resultados = m.content.filter((b) => b.toolResult);
      if (resultados.length) {
        const dono = itens[itens.length - 1];
        for (const { toolResult } of resultados) {
          const texto = toolResult!.content.map((c) => c.text ?? "").join("");
          let resultado: unknown = texto;
          try {
            resultado = JSON.parse(texto);
          } catch {
            /* mantem texto */
          }
          const tool = dono?.tools.find((t) => t.id === toolResult!.toolUseId);
          if (tool) tool.resultado = resultado;
        }
      }
      if (textos.length) itens.push({ role: "user", texto: textos.join("\n"), tools: [] });
      continue;
    }
    // assistant: junta com o balao anterior se ainda for o mesmo turno.
    let alvo = itens[itens.length - 1];
    if (!alvo || alvo.role !== "assistant") {
      alvo = { role: "assistant", texto: "", tools: [] };
      itens.push(alvo);
    }
    const texto = textos.join("\n").replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();
    if (texto) alvo.texto += (alvo.texto ? "\n\n" : "") + texto;
    for (const b of m.content) {
      if (b.toolUse) alvo.tools.push({ id: b.toolUse.toolUseId, nome: b.toolUse.name, argumentos: b.toolUse.input });
    }
  }
  return itens;
}
