import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Conversa,
  MensagemStrands,
  PendenciaChat,
} from "../src/types/chat";
import { lerEventosSse } from "../src/services/sse";
import { enviarMensagem } from "../src/services/chat";
import { extrairPedidoAtual } from "../src/utils/derivarPedido";
import {
  historicoParaContent,
  historicoParaMensagens,
} from "../src/utils/strands";
import {
  pendenciaConcluida,
  podeReenviar,
} from "../src/utils/pendencias";

vi.mock("../src/services/auth", () => ({
  obterAccessToken: vi.fn(async () => "TOKEN_DE_TESTE"),
}));

vi.mock("../src/services/config", () => ({
  carregarConfig: vi.fn(async () => ({
    apiUrl: "https://perfil.example",
    chatApiUrl: "https://chat.example/prod",
    cognito: {
      region: "us-east-1",
      userPoolId: "us-east-1_teste",
      userPoolClientId: "client-teste",
    },
  })),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function fluxo(texto: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(texto);

  return new ReadableStream({
    start(controller) {
      for (const byte of bytes) {
        controller.enqueue(Uint8Array.of(byte));
      }
      controller.close();
    },
  });
}

function retorno(
  nome: string,
  resultado: unknown,
  id: string,
  input: Record<string, unknown> = {},
): MensagemStrands[] {
  return [
    {
      role: "assistant",
      content: [{ toolUse: { toolUseId: id, name: nome, input } }],
    },
    {
      role: "user",
      content: [{
        toolResult: {
          toolUseId: id,
          status: "success",
          content: [{ text: JSON.stringify(resultado) }],
        },
      }],
    },
  ];
}

const pedido: PendenciaChat = {
  conversa_id: "11111111-1111-4111-8111-111111111111",
  requisicao_id: "22222222-2222-4222-8222-222222222222",
  mensagem: "Olá",
};

function conversa(): Conversa {
  return {
    conversa_id: pedido.conversa_id,
    estado: "livre",
    versao: 1,
    criada_em: "2026-11-16T12:00:00Z",
    atualizada_em: "2026-11-16T12:00:00Z",
    requisicao_id: null,
    historico: [],
    requisicao: null,
  };
}

describe("streaming", () => {
  it("preserva UTF-8 e ignora comentários SSE", async () => {
    const recebidos = [];

    for await (const evento of lerEventosSse(
      fluxo(': aguardando\r\n\r\ndata: {"texto":"ação"}\r\n\r\n'),
    )) {
      recebidos.push(evento);
    }

    expect(recebidos).toEqual([{ texto: "ação" }]);
  });

  it("rejeita evento truncado", async () => {
    await expect(async () => {
      for await (const evento of lerEventosSse(
        fluxo('data: {"texto":"parcial"}'),
      )) void evento;
    }).rejects.toThrow();
  });

  it("envia somente a mensagem e os IDs e entrega delta antes do fim", async () => {
    const final = {
      tipo: "fim",
      ...pedido,
      versao: 1,
      resposta: "Oi",
      repetida: false,
      historico: [
        { role: "user", content: [{ text: "Olá" }] },
        { role: "assistant", content: [{ text: "Oi" }] },
      ],
    };

    const fetchMock = vi.fn(async () => new Response(
      fluxo(
        'data: {"tipo":"delta","texto":"Oi"}\n\n' +
        `data: ${JSON.stringify(final)}\n\n`,
      ),
      { headers: { "Content-Type": "text/event-stream" } },
    ));

    vi.stubGlobal("fetch", fetchMock);

    const eventos: string[] = [];
    const resultado = await enviarMensagem(
      pedido,
      (evento) => eventos.push(evento.tipo),
    );

    expect(eventos).toEqual(["delta", "fim"]);
    expect(resultado.resposta).toBe("Oi");

    const chamadas = fetchMock.mock.calls as unknown as [
      string,
      RequestInit,
    ][];
    const [url, opcoes] = chamadas[0];

    expect(url).toBe("https://chat.example/prod/chat");
    expect(JSON.parse(String(opcoes.body))).toEqual(pedido);
    expect(new Headers(opcoes.headers).get("Authorization"))
      .toBe("Bearer TOKEN_DE_TESTE");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("não repete uma chamada cujo streaming terminou sem fim", async () => {
    const fetchMock = vi.fn(async () => new Response(
      fluxo('data: {"tipo":"delta","texto":"Parcial"}\n\n'),
      { headers: { "Content-Type": "text/event-stream" } },
    ));

    vi.stubGlobal("fetch", fetchMock);

    await expect(enviarMensagem(pedido, () => {}))
      .rejects.toThrow("interrompida");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("histórico Strands e pedido", () => {
  it("não exibe resultados de ferramentas como falas do usuário", () => {
    const historico: MensagemStrands[] = [
      { role: "user", content: [{ text: "Mostre eventos" }] },
      ...retorno("listar_catalogo", { produtos: [] }, "tool-1"),
      { role: "assistant", content: [{ text: "Catálogo vazio" }] },
    ];

    expect(historicoParaMensagens(historico).map((item) => item.texto))
      .toEqual(["Mostre eventos", "Catálogo vazio"]);

    expect(JSON.stringify(historicoParaContent(historico)))
      .toContain("functionResponse");
  });

  it("uma nova intenção substitui a compra anterior no painel", () => {
    const historico = [
      ...retorno("registrar_intencao", {
        intencaoId: "int-1",
        eventoId: "evt_004",
        quantidade: 1,
        valorTotal: 25,
        status: "pendente",
      }, "registro-1"),
      ...retorno("realizar_compra", {
        intencao_id: "int-1",
        status: "aprovado",
        valor: 25,
        metodo_pagamento: "pix",
      }, "compra-1"),
      ...retorno("registrar_intencao", {
        intencaoId: "int-2",
        eventoId: "evt_002",
        quantidade: 1,
        valorTotal: 45,
        expiraEm: "2026-11-16T15:05:00Z",
        status: "pendente",
      }, "registro-2"),
    ];

    expect(extrairPedidoAtual(historico)).toMatchObject({
      intencaoId: "int-2",
      status: "pendente",
      valorTotal: 45,
      expiraEm: "2026-11-16T15:05:00Z",
    });
  });

  it("uma recusa não vira aprovação e preserva o motivo do backend", () => {
    const historico = [
      ...retorno("registrar_intencao", {
        intencaoId: "int-1",
        eventoId: "evt_003",
        quantidade: 1,
        valorTotal: 1150,
      }, "registro"),
      ...retorno("realizar_compra", {
        status: "recusado",
        erro: "LIMITE_EXCEDIDO",
        mensagem: "Limite insuficiente.",
      }, "compra", { intencao_id: "int-1" }),
    ];

    expect(extrairPedidoAtual(historico)).toMatchObject({
      status: "recusado",
      codigoErro: "LIMITE_EXCEDIDO",
      mensagemErro: "Limite insuficiente.",
      valorTotal: 1150,
    });
  });
});

describe("recuperação", () => {
  it("permite reenvio somente quando a requisição não foi recebida", () => {
    for (const estado of [
      "processando",
      "incerta",
      "concluida",
    ] as const) {
      const atual = conversa();

      atual.requisicao = {
        requisicao_id: pedido.requisicao_id,
        estado,
        versao: estado === "concluida" ? 1 : null,
      };

      expect(podeReenviar(atual, pedido)).toBe(false);
    }

    const atual = conversa();
    atual.requisicao = {
      requisicao_id: pedido.requisicao_id,
      estado: "nao_recebida",
      versao: null,
    };

    expect(podeReenviar(atual, pedido)).toBe(true);

    atual.estado = "processando";
    expect(podeReenviar(atual, pedido)).toBe(false);
  });

  it("só limpa a pendência quando o ID e a versão foram confirmados", () => {
    const atual = conversa();

    atual.requisicao = {
      requisicao_id: pedido.requisicao_id,
      estado: "concluida",
      versao: 2,
    };

    expect(pendenciaConcluida(atual, pedido)).toBe(false);

    atual.versao = 2;
    expect(pendenciaConcluida(atual, pedido)).toBe(true);

    atual.requisicao.requisicao_id = "outra";
    expect(pendenciaConcluida(atual, pedido)).toBe(false);
  });
});
