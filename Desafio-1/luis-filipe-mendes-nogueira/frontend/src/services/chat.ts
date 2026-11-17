import type {
  ConsultaRequisicao,
  Conversa,
  EventoChat,
  MensagemStrands,
  PendenciaChat,
  ResumoConversa,
  ResultadoChat,
} from "../types/chat";
import { ehMensagemStrands, registro } from "../types/chat";
import { ErroApi, requisicaoAutenticada } from "./api";
import { lerEventosSse } from "./sse";

function invalida(): never {
  throw new ErroApi(
    0,
    "RESPOSTA_INVALIDA",
    "Não foi possível confirmar a resposta. Verifique o resultado.",
  );
}

function historico(valor: unknown): MensagemStrands[] {
  if (!Array.isArray(valor) || !valor.every(ehMensagemStrands)) {
    return invalida();
  }

  return valor;
}

function resumo(valor: unknown): ResumoConversa {
  const item = registro(valor);

  if (
    !item ||
    typeof item.conversa_id !== "string" ||
    !["livre", "processando", "incerta"].includes(String(item.estado)) ||
    !Number.isInteger(item.versao) ||
    Number(item.versao) < 0 ||
    typeof item.criada_em !== "string" ||
    typeof item.atualizada_em !== "string" ||
    !(item.requisicao_id === null ||
      typeof item.requisicao_id === "string")
  ) {
    return invalida();
  }

  return item as unknown as ResumoConversa;
}

function consulta(valor: unknown): ConsultaRequisicao | null {
  if (valor == null) return null;

  const item = registro(valor);

  if (
    !item ||
    typeof item.requisicao_id !== "string" ||
    !["nao_recebida", "processando", "incerta", "concluida"]
      .includes(String(item.estado)) ||
    !(item.versao === null ||
      (Number.isInteger(item.versao) && Number(item.versao) >= 1))
  ) {
    return invalida();
  }

  return item as unknown as ConsultaRequisicao;
}

export async function listarConversas(
  signal?: AbortSignal,
): Promise<ResumoConversa[]> {
  const resposta = await requisicaoAutenticada(
    "/conversas",
    { signal },
    "chat",
  );

  const dados = registro(await resposta.json());

  if (!dados || !Array.isArray(dados.conversas)) return invalida();

  return dados.conversas.map(resumo);
}

export async function criarConversa(): Promise<Conversa> {
  const resposta = await requisicaoAutenticada(
    "/conversas",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
    "chat",
  );

  return {
    ...resumo(await resposta.json()),
    historico: [],
    requisicao: null,
  };
}

export async function buscarConversa(
  conversaId: string,
  requisicaoId?: string,
  signal?: AbortSignal,
): Promise<Conversa> {
  const parametros = requisicaoId
    ? `?requisicao_id=${encodeURIComponent(requisicaoId)}`
    : "";

  const resposta = await requisicaoAutenticada(
    `/conversas/${encodeURIComponent(conversaId)}${parametros}`,
    { signal },
    "chat",
  );

  const dados = registro(await resposta.json());

  if (!dados) return invalida();

  return {
    ...resumo(dados),
    historico: historico(dados.historico),
    requisicao: consulta(dados.requisicao),
  };
}

export async function enviarMensagem(
  pedido: PendenciaChat,
  receber: (evento: EventoChat) => void,
  signal?: AbortSignal,
): Promise<ResultadoChat> {
  const prazo = AbortSignal.timeout(140_000);
  const sinal = signal ? AbortSignal.any([signal, prazo]) : prazo;

  const resposta = await requisicaoAutenticada(
    "/chat",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        conversa_id: pedido.conversa_id,
        requisicao_id: pedido.requisicao_id,
        mensagem: pedido.mensagem,
      }),
      signal: sinal,
    },
    "chat",
  );

  if (
    !resposta.body ||
    !resposta.headers.get("content-type")?.startsWith("text/event-stream")
  ) {
    return invalida();
  }

  for await (const bruto of lerEventosSse(resposta.body)) {
    const item = registro(bruto);

    if (!item) return invalida();

    if (item.tipo === "erro") {
      throw new ErroApi(
        200,
        typeof item.erro === "string" ? item.erro : "EXECUCAO_INCERTA",
        typeof item.mensagem === "string"
          ? item.mensagem
          : "Verifique o resultado antes de repetir uma compra.",
      );
    }

    if (item.tipo === "delta" && typeof item.texto === "string") {
      receber({ tipo: "delta", texto: item.texto });
      continue;
    }

    if (
      item.tipo === "mensagem" &&
      Number.isInteger(item.sequencia) &&
      Number(item.sequencia) > 0 &&
      ehMensagemStrands(item.mensagem)
    ) {
      receber({
        tipo: "mensagem",
        sequencia: Number(item.sequencia),
        mensagem: item.mensagem,
      });
      continue;
    }

    if (
      item.conversa_id !== pedido.conversa_id ||
      item.requisicao_id !== pedido.requisicao_id ||
      typeof item.repetida !== "boolean"
    ) {
      return invalida();
    }

    if (item.tipo === "inicio") {
      receber({
        tipo: "inicio",
        conversa_id: pedido.conversa_id,
        requisicao_id: pedido.requisicao_id,
        repetida: item.repetida,
      });
      continue;
    }

    if (
      item.tipo === "fim" &&
      typeof item.resposta === "string" &&
      Number.isInteger(item.versao) &&
      Number(item.versao) >= 1
    ) {
      const resultado: ResultadoChat = {
        tipo: "fim",
        conversa_id: pedido.conversa_id,
        requisicao_id: pedido.requisicao_id,
        versao: Number(item.versao),
        resposta: item.resposta,
        historico: historico(item.historico),
        repetida: item.repetida,
      };

      receber(resultado);
      return resultado;
    }

    return invalida();
  }

  throw new ErroApi(
    0,
    "RESPOSTA_INTERROMPIDA",
    "A resposta foi interrompida. Verifique o resultado antes de reenviar.",
  );
}
