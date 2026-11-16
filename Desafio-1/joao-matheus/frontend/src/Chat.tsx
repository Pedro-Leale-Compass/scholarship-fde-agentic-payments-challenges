import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import type { AppConfig } from './config';
import {
  enviarMensagem,
  buscarConversas,
  NaoAutenticadoError,
} from './api';

interface Message {
  role: 'user' | 'bot';
  content: string;
}

interface ChatProps {
  config: AppConfig;
  onSair: () => void;
  email?: string;
}

const DESCRICAO_FERRAMENTAS: Record<string, string> = {
  listar_catalogo: 'Consultando catálogo de produtos...',
  registrar_intencao: 'Registrando intenção de compra...',
  realizar_compra: 'Processando pagamento...',
};

export default function Chat({ config, onSair, email }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [carregandoHistorico, setCarregandoHistorico] = useState(true);
  const [gerandoResposta, setGerandoResposta] = useState(false);
  const [statusFerramenta, setStatusFerramenta] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // 1. Restaurar histórico de conversas ao inicializar o componente
  useEffect(() => {
    let ativo = true;

    async function carregar() {
      try {
        const historico = await buscarConversas(config);
        if (ativo) {
          if (historico.length > 0) {
            setMessages(
              historico.map((m) => ({
                role: m.role === 'assistant' ? 'bot' : 'user',
                content: m.texto,
              }))
            );
          } else {
            setMessages([
              {
                role: 'bot',
                content:
                  'Olá! Sou seu assistente financeiro de compras. Como posso ajudar com suas compras hoje?',
              },
            ]);
          }
        }
      } catch (err) {
        if (err instanceof NaoAutenticadoError) {
          onSair();
          return;
        }
        if (ativo) {
          setMessages([
            {
              role: 'bot',
              content:
                'Olá! Sou seu assistente financeiro de compras. Como posso ajudar com suas compras hoje?',
            },
          ]);
        }
      } finally {
        if (ativo) {
          setCarregandoHistorico(false);
        }
      }
    }

    carregar();

    return () => {
      ativo = false;
    };
  }, [config, onSair]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, statusFerramenta]);

  // 2. Envio de mensagem com consumo de streaming SSE
  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || gerandoResposta) return;

    const userMessage = input.trim();
    setInput('');

    // Adiciona a mensagem do usuário e cria bolha vazia para a resposta do bot
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: userMessage },
      { role: 'bot', content: '' },
    ]);

    setGerandoResposta(true);
    setStatusFerramenta(null);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const stream = enviarMensagem(config, userMessage, controller.signal);

      for await (const evento of stream) {
        if (evento.tipo === 'delta' && evento.texto) {
          setStatusFerramenta(null);
          setMessages((prev) => {
            const novas = [...prev];
            const ultimoIdx = novas.length - 1;
            if (ultimoIdx >= 0 && novas[ultimoIdx].role === 'bot') {
              novas[ultimoIdx] = {
                ...novas[ultimoIdx],
                content: novas[ultimoIdx].content + evento.texto,
              };
            }
            return novas;
          });
        } else if (evento.tipo === 'ferramenta' && evento.nome) {
          const descricao = DESCRICAO_FERRAMENTAS[evento.nome] || `Executando ${evento.nome}...`;
          setStatusFerramenta(descricao);
        } else if (evento.tipo === 'erro' && evento.mensagem) {
          setMessages((prev) => {
            const novas = [...prev];
            const ultimoIdx = novas.length - 1;
            if (ultimoIdx >= 0 && novas[ultimoIdx].role === 'bot') {
              novas[ultimoIdx] = {
                ...novas[ultimoIdx],
                content:
                  novas[ultimoIdx].content +
                  `\n\n⚠️ *${evento.mensagem}*`,
              };
            }
            return novas;
          });
        }
      }
    } catch (err: any) {
      if (err instanceof NaoAutenticadoError) {
        onSair();
        return;
      }
      if (err.name !== 'AbortError') {
        setMessages((prev) => {
          const novas = [...prev];
          const ultimoIdx = novas.length - 1;
          if (ultimoIdx >= 0 && novas[ultimoIdx].role === 'bot') {
            novas[ultimoIdx] = {
              ...novas[ultimoIdx],
              content:
                novas[ultimoIdx].content ||
                'Desculpe, ocorreu uma instabilidade na comunicação. Tente novamente.',
            };
          }
          return novas;
        });
      }
    } finally {
      setGerandoResposta(false);
      setStatusFerramenta(null);
      abortControllerRef.current = null;
    }
  };

  const handleParar = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setGerandoResposta(false);
      setStatusFerramenta(null);
    }
  };

  return (
    <div className="chat-container">
      <header className="chat-header">
        <div className="header-info">
          <h2>Assistente Financeiro</h2>
          {email && <span className="user-email">{email}</span>}
        </div>
        <button className="logout-btn" onClick={onSair} title="Encerrar sessão">
          Sair
        </button>
      </header>

      <main className="chat-messages">
        {carregandoHistorico ? (
          <div className="loading">Carregando histórico de conversas...</div>
        ) : (
          messages.map((msg, idx) => (
            <div key={idx} className={`message ${msg.role}`}>
              {msg.role === 'bot' ? (
                msg.content ? (
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                ) : (
                  <span className="digitando">Pensando...</span>
                )
              ) : (
                msg.content
              )}
            </div>
          ))
        )}

        {statusFerramenta && (
          <div className="tool-indicator">
            <span className="spinner">⚙️</span> {statusFerramenta}
          </div>
        )}

        <div ref={messagesEndRef} />
      </main>

      <form className="chat-input" onSubmit={handleSend}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={gerandoResposta ? 'Aguarde a resposta...' : 'Digite sua mensagem...'}
          disabled={gerandoResposta || carregandoHistorico}
          autoFocus
        />
        {gerandoResposta ? (
          <button type="button" className="stop-btn" onClick={handleParar}>
            Parar
          </button>
        ) : (
          <button type="submit" disabled={!input.trim() || carregandoHistorico}>
            Enviar
          </button>
        )}
      </form>
    </div>
  );
}
