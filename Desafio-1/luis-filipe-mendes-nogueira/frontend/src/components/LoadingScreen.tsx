"use client";

const ETAPAS = [
  "Preparando seu acesso",
  "Reconhecendo sua conta",
  "Conferindo quanto você pode gastar",
  "Abrindo sua conversa",
];

interface LoadingScreenProps {
  etapaAtual: number;
  erro?: string;
  saindo?: boolean;
  onTentarNovamente: () => void;
  onSair: () => void;
}

export default function LoadingScreen({
  etapaAtual,
  erro,
  saindo = false,
  onTentarNovamente,
  onSair,
}: LoadingScreenProps) {
  return (
    <main className="ig-tela-carregando" aria-busy={!erro}>
      <div className="ig-carregando">
        <div className="ig-carregando__blocos" aria-hidden="true">
          {ETAPAS.map((_, indice) => (
            <span
              key={indice}
              className={`ig-carregando__bloco ${
                indice < etapaAtual
                  ? "ig-carregando__bloco--feito"
                  : indice === etapaAtual && !erro
                    ? "ig-carregando__bloco--agora"
                    : ""
              }`}
            />
          ))}
        </div>

        <h1
          style={{
            font: "var(--t-t2)",
            letterSpacing: "var(--track-titulo)",
            marginTop: "var(--e-6)",
          }}
        >
          {erro ? "Não conseguimos continuar" : "Só um instante"}
        </h1>

        {erro ? (
          <p
            role="alert"
            style={{
              font: "var(--t-corpo)",
              marginTop: "var(--e-2)",
            }}
          >
            {erro}
          </p>
        ) : (
          <p
            style={{
              font: "var(--t-corpo)",
              color: "var(--c-tinta-70)",
              marginTop: "var(--e-2)",
            }}
          >
            Estamos deixando tudo pronto para você conversar.
          </p>
        )}

        <div className="ig-etapas" aria-live="polite">
          {ETAPAS.map((etapa, indice) => {
            const estado =
              indice < etapaAtual
                ? "feita"
                : indice === etapaAtual && !erro
                  ? "agora"
                  : "espera";

            return (
              <div
                key={etapa}
                className={`ig-etapa ig-etapa--${estado}`}
              >
                <span className="ig-etapa__marca" />
                <span className="ig-etapa__nome">{etapa}</span>
                <span className="ig-etapa__estado">
                  {indice === etapaAtual && erro
                    ? "interrompido"
                    : estado === "feita"
                      ? "pronto"
                      : estado === "agora"
                        ? "agora"
                        : "em fila"}
                </span>
              </div>
            );
          })}
        </div>

        {erro && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "var(--e-2)",
              marginTop: "var(--e-6)",
            }}
          >
            <button
              type="button"
              className="ig-botao ig-botao--principal"
              onClick={onTentarNovamente}
              disabled={saindo}
            >
              Tentar novamente
            </button>

            <button
              type="button"
              className="ig-botao ig-botao--contorno"
              onClick={onSair}
              disabled={saindo}
            >
              {saindo ? "Saindo…" : "Sair da conta"}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
