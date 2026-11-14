"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Content, MensagemUI, Usuario } from "../types";
import {
  enviarMensagem,
  buscarPerfil,
  SessaoExpiradaError,
} from "../services/api";
import { encerrarSessao } from "../services/auth";
import { extrairPedidoAtual } from "../utils/derivarPedido";
import MessageBubble from "./MessageBubble";
import ToolCallBadge from "./ToolCallBadge";
import OrderPanel from "./OrderPanel";
import SystemFailureScreen from "./SystemFailureScreen";

const SUGESTOES = [
  "tem mais barato?",
  "quero dois ingressos",
  "o que rola domingo?",
];

interface ChatWindowProps {
  usuarioInicial: Usuario;
}

export default function ChatWindow({
  usuarioInicial,
}: ChatWindowProps) {
  const router = useRouter();

  const [historico, setHistorico] = useState<Content[]>([]);
  const [mensagens, setMensagens] = useState<MensagemUI[]>([]);
  const [entrada, setEntrada] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [saindo, setSaindo] = useState(false);
  const [erroLogout, setErroLogout] = useState("");
  const [falhaSistema, setFalhaSistema] = useState(false);
  const [usuario, setUsuario] = useState<Usuario>(usuarioInicial);

  const pedido = extrairPedidoAtual(historico);

  async function handleLogout() {
    if (saindo) return;

    setSaindo(true);
    setErroLogout("");

    try {
      await encerrarSessao();
      router.replace("/login");
    } catch {
      setErroLogout("Não foi possível sair. Tente novamente.");
      setSaindo(false);
    }
  }

  async function enviar(texto: string) {
    if (!texto.trim() || carregando || saindo) return;

    setMensagens((atuais) => [
      ...atuais,
      { id: crypto.randomUUID(), role: "user", texto },
    ]);

    setEntrada("");
    setCarregando(true);
    setFalhaSistema(false);

    try {
      const resultado = await enviarMensagem(historico, texto);

      setHistorico(resultado.historico);
      setMensagens((atuais) => [
        ...atuais,
        {
          id: crypto.randomUUID(),
          role: "model",
          texto: resultado.resposta,
        },
      ]);

      // Atualiza o saldo caso uma compra tenha ocorrido neste turno.
      try {
        const perfilAtualizado = await buscarPerfil();
        setUsuario(perfilAtualizado);
      } catch (erro) {
        if (erro instanceof SessaoExpiradaError) {
          throw erro;
        }

        // Uma falha isolada ao atualizar o saldo não interrompe a conversa.
      }
    } catch (erro) {
      if (erro instanceof SessaoExpiradaError) {
        router.replace("/login");
        return;
      }

      setFalhaSistema(true);
    } finally {
      setCarregando(false);
    }
  }

  function pagar(metodo: "cartao" | "pix") {
    void enviar(
      metodo === "pix"
        ? "Pode pagar no pix."
        : "Pode pagar no cartão.",
    );
  }

  function reiniciarPedido() {
    setHistorico([]);
    setMensagens([]);
  }

  if (falhaSistema) {
    return (
      <SystemFailureScreen
        onTentarNovamente={() => setFalhaSistema(false)}
        onVoltar={() => {
          setFalhaSistema(false);
          reiniciarPedido();
        }}
      />
    );
  }

  return (
    <div className="ig-app">
      <div className="ig-app__lateral">
        <div className="ig-cabecalho">
          <div className="ig-quadro-marca" />
          <span className="ig-cabecalho__titulo">Ingressos</span>
        </div>

        <div className="ig-conversas__titulo">Suas conversas</div>

        <div className="ig-conversa-item ig-conversa-item--ativo">
          Ingressos para hoje
        </div>

        <div className="ig-saldo">
          <div className="ig-saldo__rotulo">Você pode gastar</div>

          <div className="ig-saldo__valor">
            {new Intl.NumberFormat("pt-BR", {
              style: "currency",
              currency: "BRL",
            }).format(usuario.limiteGasto)}
          </div>
        </div>

        <div className="ig-lateral-usuario">
          <div className="ig-lateral-usuario__info">
            <span className="ig-lateral-usuario__rotulo">
              Conectado como
            </span>

            <strong className="ig-lateral-usuario__nome">
              {usuario.username}
            </strong>
          </div>

          <button
            type="button"
            className="ig-botao ig-botao--contorno ig-botao--compacto ig-lateral-usuario__sair"
            onClick={() => void handleLogout()}
            disabled={saindo}
          >
            {saindo ? "Saindo…" : "Sair da conta"}
          </button>

          {erroLogout && <p role="alert">{erroLogout}</p>}
        </div>
      </div>

      <div className="ig-app__conversa">
        <div className="ig-cabecalho">
          <div>
            <div className="ig-cabecalho__titulo">
              Ingressos para hoje
            </div>

            <div className="ig-cabecalho__estado">
              Assistente disponível agora
            </div>
          </div>
        </div>

        <div className="ig-mensagens">
          {mensagens.map((mensagem) => (
            <MessageBubble
              key={mensagem.id}
              mensagem={mensagem}
            />
          ))}

          {carregando && <ToolCallBadge />}
        </div>

        <div className="ig-escrita">
          <div className="ig-escrita__atalhos">
            {SUGESTOES.map((sugestao) => (
              <button
                key={sugestao}
                type="button"
                className="ig-chip"
                onClick={() => void enviar(sugestao)}
                disabled={carregando || saindo}
              >
                {sugestao}
              </button>
            ))}
          </div>

          <form
            className="ig-escrita__linha"
            onSubmit={(evento) => {
              evento.preventDefault();
              void enviar(entrada);
            }}
          >
            <input
              className="ig-escrita__entrada"
              value={entrada}
              onChange={(evento) => setEntrada(evento.target.value)}
              placeholder="Escreva aqui"
              disabled={saindo}
            />

            <button
              type="submit"
              className="ig-botao ig-botao--principal ig-escrita__enviar"
              disabled={carregando || saindo || !entrada.trim()}
            >
              Enviar
            </button>
          </form>
        </div>
      </div>

      <OrderPanel
        pedido={pedido}
        usuario={usuario}
        onPagar={pagar}
        onVerOpcoesMaisBaratas={() => {
          void enviar("tem mais barato?");
        }}
        onComprarOutro={reiniciarPedido}
      />
    </div>
  );
}