"use client";

import { useEffect, useState } from "react";
import type { Usuario } from "../types";
import type { PedidoChat } from "../types/chat";

interface OrderPanelProps {
  pedido: PedidoChat | null;
  usuario: Usuario;
  bloqueado?: boolean;
  onPagar: (metodo: "cartao" | "pix") => void;
  onVerOpcoesMaisBaratas: () => void;
  onComprarOutro: () => void;
}

function valor(numero: number, moeda = "BRL") {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: moeda,
  }).format(numero);
}

export default function OrderPanel({
  pedido,
  usuario,
  bloqueado = false,
  onPagar,
  onVerOpcoesMaisBaratas,
  onComprarOutro,
}: OrderPanelProps) {
  const [agora, setAgora] = useState(0);

  useEffect(() => {
    setAgora(Date.now());
    const timer = setInterval(() => setAgora(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const prazo = pedido?.expiraEm ? Date.parse(pedido.expiraEm) : NaN;
  const segundos = Number.isFinite(prazo) && agora
    ? Math.max(0, Math.ceil((prazo - agora) / 1000))
    : null;
  const expirou = segundos === 0;

  return (
    <aside className="ig-app__pedido">
      <div className="ig-cabecalho">
        <span className="ig-cabecalho__titulo">Seu pedido</span>
      </div>

      <div className="ig-pedido">
        {!pedido && <p>Nenhum pedido em andamento ainda.</p>}

        {pedido?.status === "aprovado" && (
          <div className="ig-resultado ig-resultado--aprovado">
            <div className="ig-resultado__faixa">
              Compra simulada aprovada
            </div>
            <div className="ig-resultado__corpo">
              <p className="ig-resultado__frase">
                {pedido.quantidade} ingresso(s) para {pedido.nome}.
              </p>
              <p>
                Valor: <strong>{valor(pedido.valorTotal, pedido.moeda)}</strong>
              </p>
              <p>
                Método: {pedido.metodoPagamento === "pix" ? "Pix" : "Cartão"}
              </p>
              <p>Saldo disponível: {valor(usuario.limiteGasto)}</p>
              {pedido.transacaoId && (
                <p style={{ overflowWrap: "anywhere" }}>
                  Transação: <code>{pedido.transacaoId}</code>
                </p>
              )}
              <button
                type="button"
                className="ig-botao ig-botao--contorno"
                onClick={onComprarOutro}
                disabled={bloqueado}
              >
                Comprar outro
              </button>
            </div>
          </div>
        )}

        {pedido?.status === "recusado" && (
          <div className="ig-resultado ig-resultado--bloqueio">
            <div className="ig-resultado__faixa">Compra não concluída</div>
            <div className="ig-resultado__corpo">
              <p className="ig-resultado__frase">
                {pedido.mensagemErro ?? "Não foi possível concluir este pedido."}
              </p>
              {pedido.valorTotal > 0 && (
                <p>Valor do pedido: {valor(pedido.valorTotal, pedido.moeda)}</p>
              )}
              <p>Disponível: {valor(usuario.limiteGasto)}</p>
              <button
                type="button"
                className="ig-botao ig-botao--principal"
                onClick={onVerOpcoesMaisBaratas}
                disabled={bloqueado}
              >
                Ver opções mais baratas
              </button>
              <button
                type="button"
                className="ig-botao ig-botao--contorno"
                onClick={onComprarOutro}
                disabled={bloqueado}
              >
                Nova conversa
              </button>
            </div>
          </div>
        )}

        {pedido?.status === "pendente" && (
          <>
            <div className="ig-pedido__capa" />
            <p className="ig-pedido__nome">{pedido.nome}</p>
            <div className="ig-pedido__linha">
              <span>Quantidade</span>
              <strong>{pedido.quantidade}</strong>
            </div>
            <div className="ig-pedido__linha">
              <span>Total</span>
              <strong className="ig-pedido__total">
                {valor(pedido.valorTotal, pedido.moeda)}
              </strong>
            </div>

            <div className="ig-pedido__prazo" role="status">
              {expirou
                ? "A reserva expirou. Peça uma nova reserva no chat."
                : segundos !== null
                  ? `Reserva válida por ${Math.floor(segundos / 60)}:${String(segundos % 60).padStart(2, "0")}.`
                  : "O pagamento depende da validade da reserva."}
            </div>

            <div className="ig-pedido__pagamento">
              <p>Confirmar compra simulada com:</p>
              {(["pix", "cartao"] as const).map((metodo) => (
                <button
                  key={metodo}
                  type="button"
                  className="ig-botao ig-botao--principal ig-botao--bloco"
                  onClick={() => onPagar(metodo)}
                  disabled={
                    bloqueado || expirou || !agora || !pedido.intencaoId
                  }
                >
                  {metodo === "pix" ? "Pagar com Pix" : "Pagar com cartão"}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
