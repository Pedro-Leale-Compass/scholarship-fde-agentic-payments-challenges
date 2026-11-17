
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import {
  enviarMensagem,
  confirmarPagamento,
  type MetodoPagamento,
} from "../services/chat";

type Mensagem = {
  id: string;
  autor: "usuario" | "agente";
  texto: string;
};

export default function Chat() {
  const [mensagens, setMensagens] = useState<Mensagem[]>([]);
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [erro, setErro] = useState("");
  const [intencaoPendente, setIntencaoPendente] =
    useState<string | null>(null);

  const enviandoRef = useRef(false);
  const confirmandoRef = useRef(false);

  const finalDaConversa = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    finalDaConversa.current?.scrollIntoView({
      behavior: "smooth",
    });
  }, [mensagens, enviando, confirmando]);

  function adicionarMensagem(
    autor: "usuario" | "agente",
    texto: string
  ) {
    setMensagens((anteriores) => [
      ...anteriores,
      {
        id: crypto.randomUUID(),
        autor,
        texto,
      },
    ]);
  }

  async function handleEnviar(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    const mensagem = texto.trim();

    if (!mensagem || enviandoRef.current || confirmandoRef.current) {
      return;
    }

    if (mensagem.length > 4000) {
      setErro("A mensagem deve ter no máximo 4.000 caracteres.");
      return;
    }

    enviandoRef.current = true;
    setEnviando(true);
    setErro("");
    setTexto("");

    adicionarMensagem("usuario", mensagem);

    try {
      const resposta = await enviarMensagem(mensagem);

      adicionarMensagem("agente", resposta);

      // Identifica a intenção retornada pelo agente.
      const correspondencia = resposta.match(
        /int_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
      );

      if (correspondencia) {
        setIntencaoPendente(correspondencia[0]);
      }

    } catch (error) {
      setErro(
        error instanceof Error
          ? error.message
          : "Não foi possível enviar a mensagem."
      );
    } finally {
      enviandoRef.current = false;
      setEnviando(false);
    }
  }

  async function handleConfirmarPagamento(
    metodo: MetodoPagamento
  ) {
    if (!intencaoPendente || confirmandoRef.current) {
      return;
    }

    confirmandoRef.current = true;
    setConfirmando(true);
    setErro("");

    try {
      const resultado = await confirmarPagamento(
        intencaoPendente,
        metodo
      );

      const valor = Number(
        resultado.valor_total
      ).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
      });

      adicionarMensagem(
        "agente",
        [
          "## Compra realizada com sucesso!",
          "",
          `**ID da transação:** ${resultado.transacao_id}`,
          "",
          `**ID da intenção:** ${resultado.intencao_id}`,
          "",
          `**Valor:** ${valor}`,
          "",
          `**Método:** ${resultado.metodo_pagamento}`,
          "",
          `**Status:** ${resultado.status}`,
          "",
          resultado.idempotente
            ? "Esta foi uma recuperação da transação original."
            : "Pagamento simulado aprovado com sucesso.",
        ].join("\n")
      );

      setIntencaoPendente(null);

    } catch (error) {
      setErro(
        error instanceof Error
          ? error.message
          : "Não foi possível confirmar o pagamento."
      );
    } finally {
      confirmandoRef.current = false;
      setConfirmando(false);
    }
  }

  return (
    <section className="chat-container">
      <div className="chat-messages" aria-live="polite">

        {mensagens.length === 0 && (
          <div className="chat-welcome">
            <h2>Olá! Como posso ajudar?</h2>

            <p>
              Sou seu assistente de compras. Posso apresentar os
              produtos disponíveis e responder às suas perguntas.
            </p>

            <p>
              Experimente perguntar: "Quais produtos estão disponíveis?"
            </p>
          </div>
        )}

        {mensagens.map((mensagem) => (
          <div
            key={mensagem.id}
            className={`chat-message ${mensagem.autor}`}
          >
            <span className="chat-message-author">
              {mensagem.autor === "usuario"
                ? "Você"
                : "Assistente"}
            </span>

            <div className="chat-message-text">
              {mensagem.autor === "agente" ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {mensagem.texto}
                </ReactMarkdown>
              ) : (
                mensagem.texto
              )}
            </div>
          </div>
        ))}

        {enviando && (
          <div className="chat-message agente">
            <span className="chat-message-author">
              Assistente
            </span>

            <div className="chat-message-text">
              Consultando o agente...
            </div>
          </div>
        )}

        {intencaoPendente && (
          <div className="chat-message agente">
            <span className="chat-message-author">
              Confirmação de pagamento
            </span>

            <div className="chat-message-text">
              <h3>Finalizar compra</h3>

              <p>
                Sua intenção de compra está pendente.
                Escolha o método de pagamento e confirme
                para prosseguir.
              </p>

              <p>
                <strong>ID:</strong> {intencaoPendente}
              </p>

              <button
                type="button"
                disabled={confirmando || enviando}
                onClick={() => handleConfirmarPagamento("PIX")}
              >
                {confirmando
                  ? "Processando..."
                  : "Confirmar com PIX"}
              </button>

              <button
                type="button"
                disabled={confirmando || enviando}
                onClick={() => handleConfirmarPagamento("CARTAO")}
              >
                {confirmando
                  ? "Processando..."
                  : "Confirmar com cartão"}
              </button>
            </div>
          </div>
        )}

        {confirmando && (
          <div className="chat-message agente">
            <span className="chat-message-author">
              Assistente
            </span>

            <div className="chat-message-text">
              Validando autorização e processando pagamento...
            </div>
          </div>
        )}

        <div ref={finalDaConversa} />
      </div>

      {erro && (
        <p className="chat-error" role="alert">
          {erro}
        </p>
      )}

      <form className="chat-form" onSubmit={handleEnviar}>
        <input
          type="text"
          placeholder="Digite sua mensagem..."
          aria-label="Mensagem para o assistente"
          value={texto}
          onChange={(event) => setTexto(event.target.value)}
          maxLength={4000}
          disabled={enviando || confirmando}
          required
        />

        <button
          type="submit"
          disabled={
            enviando ||
            confirmando ||
            !texto.trim()
          }
        >
          {enviando ? "Enviando..." : "Enviar"}
        </button>
      </form>
    </section>
  );
}
