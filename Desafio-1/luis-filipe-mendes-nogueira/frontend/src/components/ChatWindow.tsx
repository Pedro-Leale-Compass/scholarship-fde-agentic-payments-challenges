"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Usuario } from "../types";
import type {
  Conversa,
  PendenciaChat,
  ResumoConversa,
} from "../types/chat";
import {
  buscarPerfil,
  ErroApi,
  SessaoExpiradaError,
} from "../services/api";
import {
  buscarConversa,
  criarConversa,
  enviarMensagem,
  listarConversas,
} from "../services/chat";
import { encerrarSessao } from "../services/auth";
import { extrairPedidoAtual } from "../utils/derivarPedido";
import { historicoParaMensagens } from "../utils/strands";
import {
  guardarConversaSelecionada,
  guardarPendencia,
  lerConversaSelecionada,
  lerPendencia,
  limparPendencia,
  pendenciaConcluida,
  podeReenviar,
} from "../utils/pendencias";
import MessageBubble from "./MessageBubble";
import ToolCallBadge from "./ToolCallBadge";
import OrderPanel from "./OrderPanel";

const SUGESTOES = [
  "Quais eventos estão disponíveis?",
  "Quais são as opções mais baratas?",
  "Mostre os workshops disponíveis.",
];

export default function ChatWindow({
  usuarioInicial,
}: {
  usuarioInicial: Usuario;
}) {
  const router = useRouter();
  const [usuario, setUsuario] = useState(usuarioInicial);
  const [conversas, setConversas] = useState<ResumoConversa[]>([]);
  const [conversa, setConversa] = useState<Conversa | null>(null);
  const [pendencia, setPendencia] = useState<PendenciaChat | null>(null);
  const [entrada, setEntrada] = useState("");
  const [textoOtimista, setTextoOtimista] = useState("");
  const [parcial, setParcial] = useState("");
  const [carregando, setCarregando] = useState(true);
  const [transmitindo, setTransmitindo] = useState(false);
  const [saindo, setSaindo] = useState(false);
  const [erro, setErro] = useState("");
  const [avisoSaldo, setAvisoSaldo] = useState("");
  const [painel, setPainel] = useState<"conversas" | "chat" | "pedido">("chat");

  const ocupado = useRef(true);
  const ativo = useRef(true);
  const controle = useRef<AbortController | null>(null);
  const areaMensagens = useRef<HTMLDivElement>(null);
  const acompanharResposta = useRef(true);

  const pedido = extrairPedidoAtual(conversa?.historico ?? []);
  const mensagens = historicoParaMensagens(conversa?.historico ?? []);
  const bloqueado = !!pendencia || conversa?.estado !== "livre";

  function tratarErro(falha: unknown) {
    if (!ativo.current) return;

    if (falha instanceof SessaoExpiradaError) {
      setErro(
        "Seu acesso não foi aceito nesta operação. Use Sair da conta para entrar novamente.",
      );
      return;
    }

    setErro(
      falha instanceof ErroApi
        ? falha.message
        : "Não foi possível concluir. Verifique o resultado antes de reenviar.",
    );
  }

  async function carregar(id: string, signal?: AbortSignal) {
    let pendente = lerPendencia(usuarioInicial.id, id);

    const resultado = await buscarConversa(
      id,
      pendente?.requisicao_id,
      signal,
    );

    if (signal?.aborted || !ativo.current) return;

    if (pendente && pendenciaConcluida(resultado, pendente)) {
      limparPendencia(usuarioInicial.id, id);
      pendente = null;
    }

    setConversa(resultado);
    setPendencia(pendente);
    setTextoOtimista(pendente?.mensagem ?? "");
    setParcial("");
    guardarConversaSelecionada(usuarioInicial.id, id);
  }

  async function saldo() {
    try {
      const perfil = await buscarPerfil();
      if (!ativo.current) return;
      setUsuario(perfil);
      setAvisoSaldo("");
    } catch (falha) {
      if (falha instanceof SessaoExpiradaError) throw falha;
      if (ativo.current) {
        setAvisoSaldo("O saldo ainda não foi atualizado.");
      }
    }
  }

  async function executar(acao: () => Promise<void>) {
    if (ocupado.current) return;

    ocupado.current = true;
    setCarregando(true);
    setErro("");

    try {
      await acao();
    } catch (falha) {
      tratarErro(falha);
    } finally {
      ocupado.current = false;

      if (ativo.current) {
        setCarregando(false);
        setTransmitindo(false);
        setSaindo(false);
      }
    }
  }

  useEffect(() => {
    ativo.current = true;
    ocupado.current = true;

    const inicial = new AbortController();
    controle.current = inicial;

    async function iniciar() {
      try {
        const lista = await listarConversas(inicial.signal);
        if (inicial.signal.aborted) return;

        setConversas(lista);

        const selecionada = lerConversaSelecionada(usuarioInicial.id);
        const id = lista.find((item) => item.conversa_id === selecionada)
          ?.conversa_id ?? lista[0]?.conversa_id;

        if (id) await carregar(id, inicial.signal);
      } catch (falha) {
        if (!inicial.signal.aborted) tratarErro(falha);
      } finally {
        if (!inicial.signal.aborted) {
          ocupado.current = false;
          setCarregando(false);
        }
      }
    }

    void iniciar();

    return () => {
      ativo.current = false;
      inicial.abort();
      controle.current?.abort();
    };
    // A inicialização depende da identidade autenticada.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usuarioInicial.id]);

  useEffect(() => {
    const area = areaMensagens.current;
    if (area && acompanharResposta.current) area.scrollTop = area.scrollHeight;
  }, [conversa?.historico, parcial, textoOtimista, painel]);

  function novaConversa() {
    void executar(async () => {
      const nova = await criarConversa();
      if (!ativo.current) return;

      setConversa(nova);
      setPendencia(null);
      setTextoOtimista("");
      setParcial("");
      setEntrada("");
      acompanharResposta.current = true;
      setPainel("chat");
      guardarConversaSelecionada(usuarioInicial.id, nova.conversa_id);
      setConversas(await listarConversas());
    });
  }

  function selecionar(id: string) {
    void executar(async () => {
      await carregar(id);
      acompanharResposta.current = true;
      setPainel("chat");
      await saldo();
    });
  }

  function verificarResultado() {
    if (!conversa) return;

    void executar(async () => {
      await carregar(conversa.conversa_id);
      await saldo();
      setConversas(await listarConversas());
    });
  }

  function enviar(texto: string, repeticao?: PendenciaChat) {
    const mensagem = texto.trim();

    if (
      !conversa ||
      !mensagem ||
      mensagem.length > 4000 ||
      (!repeticao && bloqueado) ||
      (repeticao && !podeReenviar(conversa, repeticao))
    ) {
      return;
    }

    const atual = conversa;
    const envio: PendenciaChat = repeticao ?? {
      conversa_id: atual.conversa_id,
      requisicao_id: crypto.randomUUID(),
      mensagem,
    };

    void executar(async () => {
      const abortador = new AbortController();
      controle.current = abortador;

      guardarPendencia(usuarioInicial.id, envio);
      setPendencia(envio);
      setTextoOtimista(envio.mensagem);
      setParcial("");
      setEntrada("");
      setTransmitindo(true);
      acompanharResposta.current = true;
      setPainel("chat");

      try {
        const resultado = await enviarMensagem(
          envio,
          (evento) => {
            if (!ativo.current) return;

            if (evento.tipo === "delta") {
              setParcial((textoAtual) => textoAtual + evento.texto);
            }
          },
          abortador.signal,
        );

        if (!ativo.current) return;

        setConversa((anterior) => {
          if (!anterior || anterior.conversa_id !== resultado.conversa_id) {
            return anterior;
          }

          if (anterior.versao > resultado.versao) return anterior;

          return {
            ...anterior,
            estado: "livre",
            versao: resultado.versao,
            requisicao_id: null,
            requisicao: null,
            historico: resultado.historico,
          };
        });

        limparPendencia(usuarioInicial.id, envio.conversa_id);
        setPendencia(null);
        setTextoOtimista("");
        setParcial("");

        try {
          setConversas(await listarConversas());
        } catch {
          setErro("Resposta salva. Não foi possível atualizar a lista de conversas.");
        }
      } catch (falha) {
        // Estes códigos indicam recusa antes da execução do agente.
        if (
          falha instanceof SessaoExpiradaError ||
          (falha instanceof ErroApi && [400, 413].includes(falha.status))
        ) {
          limparPendencia(usuarioInicial.id, envio.conversa_id);
          setPendencia(null);
          setTextoOtimista("");
          setEntrada(envio.mensagem);
        }

        throw falha;
      } finally {
        if (ativo.current) await saldo();
      }
    });
  }

  function pagar(metodo: "cartao" | "pix") {
    if (!pedido?.intencaoId) return;

    const total = new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: pedido.moeda,
    }).format(pedido.valorTotal);

    enviar(
      `Confirmo a compra de ${pedido.quantidade} ingresso(s) para ` +
      `${pedido.nome}, total ${total}, intenção ${pedido.intencaoId}. ` +
      `Pagar com ${metodo === "pix" ? "Pix" : "cartão"}.`,
    );
  }

  function sair() {
    void executar(async () => {
      setSaindo(true);
      await encerrarSessao();
      router.replace("/login");
    });
  }

  return (
    <div className="ig-app" data-painel={painel}>
      <nav className="ig-navegacao" aria-label="Painéis da interface">
        {(["conversas", "chat", "pedido"] as const).map((item) => (
          <button
            key={item}
            type="button"
            className="ig-navegacao__botao"
            aria-pressed={painel === item}
            onClick={() => setPainel(item)}
          >
            {item === "conversas" ? "Conversas" : item === "chat" ? "Chat" : "Pedido"}
          </button>
        ))}
      </nav>
      <aside className="ig-app__lateral">
        <div className="ig-cabecalho">
          <div className="ig-quadro-marca" />
          <span className="ig-cabecalho__titulo">Ingressos</span>
        </div>

        <button
          type="button"
          className="ig-botao ig-botao--principal"
          onClick={novaConversa}
          disabled={carregando}
        >
          Nova conversa
        </button>

        <div className="ig-conversas__titulo">Suas conversas</div>

        <div className="ig-conversas__lista">
          {conversas.map((item) => (
            <button
              key={item.conversa_id}
              type="button"
              className={
                "ig-conversa-item" +
                (item.conversa_id === conversa?.conversa_id
                  ? " ig-conversa-item--ativo"
                  : "")
              }
              style={{ display: "block", width: "100%", textAlign: "left" }}
              onClick={() => selecionar(item.conversa_id)}
              disabled={carregando}
              aria-current={
                item.conversa_id === conversa?.conversa_id ? "true" : undefined
              }
            >
              {new Date(item.criada_em).toLocaleString("pt-BR")}
              {item.estado !== "livre" && " — verificar resultado"}
            </button>
          ))}
        </div>

        <div className="ig-saldo">
          <div className="ig-saldo__rotulo">Você pode gastar</div>
          <div className="ig-saldo__valor">
            {new Intl.NumberFormat("pt-BR", {
              style: "currency",
              currency: "BRL",
            }).format(usuario.limiteGasto)}
          </div>
          {avisoSaldo && <p role="status">{avisoSaldo}</p>}
        </div>

        <div className="ig-lateral-usuario">
          <div className="ig-lateral-usuario__info">
            <span className="ig-lateral-usuario__rotulo">Conectado como</span>
            <strong className="ig-lateral-usuario__nome">
              {usuario.username}
            </strong>
          </div>
          <button
            type="button"
            className="ig-botao ig-botao--contorno"
            onClick={sair}
            disabled={carregando}
          >
            {saindo ? "Saindo…" : "Sair da conta"}
          </button>
        </div>
      </aside>

      <section className="ig-app__conversa" aria-label="Conversa">
        <div className="ig-cabecalho">
          <div>
            <div className="ig-cabecalho__titulo">Agente de ingressos</div>
            <div className="ig-cabecalho__estado">
              {transmitindo ? "Preparando resposta…" : "Compras simuladas"}
            </div>
          </div>
        </div>

        <div
          className="ig-mensagens"
          aria-busy={transmitindo}
          ref={areaMensagens}
          onScroll={() => {
            const area = areaMensagens.current;
            if (area) {
              acompanharResposta.current =
                area.scrollHeight - area.scrollTop - area.clientHeight < 80;
            }
          }}
        >
          {!conversa && !carregando && (
            <p>Selecione uma conversa ou clique em Nova conversa.</p>
          )}

          {mensagens.map((mensagem) => (
            <MessageBubble key={mensagem.id} mensagem={mensagem} />
          ))}

          {textoOtimista && (
            <MessageBubble
              mensagem={{
                id: "mensagem-pendente",
                role: "user",
                texto: textoOtimista,
              }}
            />
          )}

          {parcial && (
            <MessageBubble
              mensagem={{
                id: "resposta-parcial",
                role: "model",
                texto: parcial,
              }}
            />
          )}

          {transmitindo && <ToolCallBadge />}

          {pendencia && !carregando && (
            <p role="status">
              Esta mensagem ainda não tem conclusão confirmada nesta tela.
            </p>
          )}

          {erro && <p role="alert">{erro}</p>}

          {conversa?.estado === "incerta" && (
            <p role="alert">
              Não foi possível confirmar a última execução. Confira o saldo e
              os registros antes de solicitar a mesma compra novamente.
            </p>
          )}

          {conversa?.estado === "processando" && !transmitindo && (
            <p role="status">
              Há uma execução em andamento ou aguardando verificação.
            </p>
          )}

          {conversa && pendencia && podeReenviar(conversa, pendencia) && (
            <div>
              <p>A requisição ainda não foi registrada pelo serviço.</p>
              <button
                type="button"
                className="ig-botao ig-botao--contorno"
                onClick={() => enviar(pendencia.mensagem, pendencia)}
                disabled={carregando}
              >
                Reenviar esta mensagem
              </button>
            </div>
          )}

        </div>

        <div className="ig-escrita">
          {conversa && (
            <button
              type="button"
              className="ig-botao ig-botao--contorno ig-escrita__verificar"
              onClick={verificarResultado}
              disabled={carregando}
            >
              Verificar resultado e atualizar conversa
            </button>
          )}
          <div className="ig-escrita__atalhos">
            {SUGESTOES.map((sugestao) => (
              <button
                key={sugestao}
                type="button"
                className="ig-chip"
                onClick={() => enviar(sugestao)}
                disabled={carregando || bloqueado}
              >
                {sugestao}
              </button>
            ))}
          </div>

          <form
            className="ig-escrita__linha"
            onSubmit={(evento) => {
              evento.preventDefault();
              enviar(entrada);
            }}
          >
            <input
              className="ig-escrita__entrada"
              value={entrada}
              onChange={(evento) => setEntrada(evento.target.value)}
              placeholder="Escreva aqui"
              aria-label="Sua mensagem"
              maxLength={4000}
              disabled={carregando || bloqueado}
            />
            <button
              type="submit"
              className="ig-botao ig-botao--principal ig-escrita__enviar"
              disabled={carregando || bloqueado || !entrada.trim()}
            >
              Enviar
            </button>
          </form>
        </div>
      </section>

      <OrderPanel
        pedido={pedido}
        usuario={usuario}
        bloqueado={carregando || bloqueado}
        onPagar={pagar}
        onVerOpcoesMaisBaratas={() => enviar("Quais são as opções mais baratas?")}
        onComprarOutro={novaConversa}
      />
    </div>
  );
}
