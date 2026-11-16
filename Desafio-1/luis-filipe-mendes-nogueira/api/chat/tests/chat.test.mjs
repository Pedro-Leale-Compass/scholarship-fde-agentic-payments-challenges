import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

import {
  ErroHttp,
  RepositorioConversas,
} from "../src/repositorio.mjs";
import { criarAplicacao } from "../src/aplicacao.mjs";
import { lerSse } from "../src/sse.mjs";

const CONVERSA = "11111111-1111-4111-8111-111111111111";
const REQUISICAO = "22222222-2222-4222-8222-222222222222";

const metadados = () => ({
  conversa_id: CONVERSA,
  estado: "livre",
  versao: 0,
});

function evento(corpo = {}) {
  return {
    resource: "/chat",
    httpMethod: "POST",
    body: JSON.stringify({
      conversa_id: CONVERSA,
      requisicao_id: REQUISICAO,
      mensagem: "Olá",
      ...corpo,
    }),
    requestContext: {
      requestId: "request-teste",
      authorizer: {
        claims: {
          sub: "usuario-autenticado",
          client_id: "client-teste",
          token_use: "access",
          exp: String(Math.floor(Date.now() / 1000) + 300),
        },
      },
    },
  };
}

function ambiente(opcoes = {}) {
  const chamadas = [];
  const saida = [];
  let resposta;

  const repo = {
    obter: async (...args) => {
      chamadas.push(["obter", ...args]);
      return metadados();
    },
    historico: async () => [],
    iniciar: async (...args) => {
      chamadas.push(["iniciar", ...args]);
      return { repetida: false };
    },
    registrarMensagem: async () => {},
    concluir: async (...args) => {
      chamadas.push(["concluir", ...args]);
      return 1;
    },
    marcarIncerta: async (...args) => {
      chamadas.push(["incerta", ...args]);
    },
    ...opcoes.repo,
  };

  const invocar = opcoes.invocar ?? (async function* (payload) {
    chamadas.push(["invocar", payload]);

    yield { tipo: "delta", texto: "Oi" };

    yield {
      tipo: "fim",
      resposta: "Oi",
      historico: [
        { role: "user", content: [{ text: payload.mensagem }] },
        { role: "assistant", content: [{ text: "Oi" }] },
      ],
    };
  });

  const app = criarAplicacao({
    repositorio: repo,
    invocar,
    clientId: "client-teste",
    origem: "http://localhost:3001",
  });

  return {
    chamadas,
    saida,
    async executar(entrada) {
      await app(entrada, (metadadosResposta) => {
        resposta = metadadosResposta;

        return async (texto) => {
          saida.push(texto);
          chamadas.push(["saida", texto]);
        };
      });

      return resposta;
    },
  };
}

test("histórico consulta todas as páginas, inclusive uma página vazia", async () => {
  const consultas = [];
  const paginas = [
    { Items: [], LastEvaluatedKey: { usuario_id: "u", registro_id: "x" } },
    {
      Items: [
        {
          versao: 1,
          mensagens_json: JSON.stringify([
            { role: "user", content: [{ text: "Primeira" }] },
          ]),
        },
        {
          versao: 2,
          mensagens_json: JSON.stringify([
            { role: "assistant", content: [{ text: "Segunda" }] },
          ]),
        },
      ],
    },
  ];

  const repo = new RepositorioConversas({
    send: async (comando) => {
      consultas.push(comando.input);
      return paginas.shift();
    },
  }, "tabela");

  const mensagens = await repo.historico("usuario-a", {
    conversa_id: CONVERSA,
    versao: 2,
  });

  assert.equal(consultas.length, 2);
  assert.equal(mensagens.length, 2);
  assert.equal(
    consultas[0].ExpressionAttributeValues[":usuario"],
    "usuario-a",
  );
  assert.equal(consultas[0].ConsistentRead, true);
  assert.deepEqual(
    consultas[1].ExclusiveStartKey,
    { usuario_id: "u", registro_id: "x" },
  );
});

test("conversa de outro usuário não é encontrada", async () => {
  let chave;

  const repo = new RepositorioConversas({
    send: async (comando) => {
      chave = comando.input.Key;
      return {};
    },
  }, "tabela");

  await assert.rejects(
    repo.obter("usuario-b", CONVERSA),
    (erro) => erro instanceof ErroHttp && erro.status === 404,
  );

  assert.equal(chave.usuario_id, "usuario-b");
});

test("início bloqueia a conversa e grava a requisição na mesma transação", async () => {
  let transacao;

  const repo = new RepositorioConversas({
    send: async (comando) => {
      if (comando.constructor.name === "GetCommand") return {};
      transacao = comando.input.TransactItems;
      return {};
    },
  }, "tabela");

  await repo.iniciar(
    "usuario-a",
    metadados(),
    REQUISICAO,
    "Olá",
    "sessao-runtime",
  );

  assert.equal(transacao.length, 2);
  assert.equal(transacao[0].Update.Key.usuario_id, "usuario-a");
  assert.match(
    transacao[0].Update.ConditionExpression,
    /versao = :versao/,
  );
  assert.equal(transacao[1].Put.Item.mensagem, "Olá");
  assert.equal(transacao[1].Put.Item.sessao_runtime, "sessao-runtime");
});

test("mesmo identificador com mensagem diferente é recusado", () => {
  const repo = new RepositorioConversas({}, "tabela");

  assert.throws(
    () => repo.verificarRepeticao(
      {
        mensagem_hash: "hash-diferente",
        estado: "processando",
      },
      "Olá",
    ),
    (erro) =>
      erro instanceof ErroHttp &&
      erro.status === 409 &&
      erro.codigo === "REQUISICAO_DIVERGENTE",
  );
});

test("requisição processando ou incerta não pode executar novamente", () => {
  const repo = new RepositorioConversas({}, "tabela");
  const mensagem = "Olá";
  const mensagemHash = createHash("sha256")
    .update(mensagem, "utf8")
    .digest("hex");

  for (const estado of ["processando", "incerta"]) {
    assert.throws(
      () => repo.verificarRepeticao(
        {
          mensagem_hash: mensagemHash,
          estado,
        },
        mensagem,
      ),
      (erro) =>
        erro instanceof ErroHttp &&
        erro.status === 409 &&
        erro.codigo === "REQUISICAO_EM_ANDAMENTO_OU_INCERTA",
    );
  }
});

test("parser preserva UTF-8 dividido entre pacotes", async () => {
  const bruto = Buffer.from(
    'data: {"tipo":"delta","texto":"ação"}\r\n\r\n',
    "utf8",
  );

  async function* pacotes() {
    for (const byte of bruto) yield Buffer.from([byte]);
  }

  const eventos = [];

  for await (const item of lerSse(pacotes())) eventos.push(item);

  assert.deepEqual(eventos, [{ tipo: "delta", texto: "ação" }]);
});

test("parser rejeita evento truncado", async () => {
  async function* pacotes() {
    yield Buffer.from('data: {"tipo":"delta"}');
  }

  await assert.rejects(async () => {
    for await (const item of lerSse(pacotes())) void item;
  });
});

test("sem claims não acessa banco nem agente", async () => {
  const a = ambiente();
  const entrada = evento();
  delete entrada.requestContext.authorizer;

  const resposta = await a.executar(entrada);

  assert.equal(resposta.statusCode, 401);
  assert.equal(a.chamadas.some(([nome]) => nome === "obter"), false);
});

test("token de outro client é recusado", async () => {
  const a = ambiente();
  const entrada = evento();
  entrada.requestContext.authorizer.claims.client_id = "outro-client";

  assert.equal((await a.executar(entrada)).statusCode, 401);
});

test("identidade e histórico enviados no corpo são recusados", async () => {
  for (const extra of [
    { usuario_id: "outro-usuario" },
    { contexto: { usuario_id: "outro-usuario" } },
    { historico: [] },
    { messages: [] },
  ]) {
    const a = ambiente();
    const resposta = await a.executar(evento(extra));

    assert.equal(resposta.statusCode, 400);
    assert.equal(a.chamadas.some(([nome]) => nome === "invocar"), false);
  }
});

test("agente recebe o sub e a conclusão é persistida antes do evento fim", async () => {
  const a = ambiente();
  const resposta = await a.executar(evento());

  assert.equal(resposta.statusCode, 200);

  const chamada = a.chamadas.find(([nome]) => nome === "invocar");

  assert.deepEqual(chamada[1].contexto, {
    usuario_id: "usuario-autenticado",
  });
  assert.deepEqual(chamada[1].historico, []);
  assert.equal(chamada[1].stream, true);

  const persistiu = a.chamadas.findIndex(([nome]) => nome === "concluir");
  const enviouFim = a.chamadas.findIndex(
    ([nome, texto]) => nome === "saida" && texto.includes('"tipo":"fim"'),
  );

  assert.ok(persistiu >= 0);
  assert.ok(enviouFim > persistiu);
});

test("requisição concluída reutiliza resposta sem chamar modelo", async () => {
  const a = ambiente({
    repo: {
      iniciar: async () => ({
        repetida: true,
        requisicao: {
          versao: 1,
          resposta: "Resposta salva",
        },
      }),
    },
  });

  await a.executar(evento());

  assert.equal(a.chamadas.some(([nome]) => nome === "invocar"), false);
  assert.ok(a.saida.join("").includes("Resposta salva"));
  assert.ok(a.saida.join("").includes('"repetida":true'));
});

test("stream sem fim marca execução incerta e não confirma turno", async () => {
  const a = ambiente({
    invocar: async function* () {
      yield { tipo: "delta", texto: "Parcial" };
    },
  });

  await a.executar(evento());

  assert.equal(a.chamadas.some(([nome]) => nome === "incerta"), true);
  assert.equal(a.chamadas.some(([nome]) => nome === "concluir"), false);
  assert.equal(a.saida.join("").includes('"tipo":"fim"'), false);
  assert.ok(a.saida.join("").includes("EXECUCAO_INCERTA"));
});

test("histórico anterior alterado pelo runtime não é confirmado", async () => {
  const anterior = [
    { role: "user", content: [{ text: "Mensagem anterior" }] },
    { role: "assistant", content: [{ text: "Resposta anterior" }] },
  ];

  const a = ambiente({
    repo: {
      historico: async () => structuredClone(anterior),
    },
    invocar: async function* () {
      yield {
        tipo: "fim",
        resposta: "Oi",
        historico: [
          { role: "user", content: [{ text: "Texto adulterado" }] },
          anterior[1],
          { role: "user", content: [{ text: "Olá" }] },
          { role: "assistant", content: [{ text: "Oi" }] },
        ],
      };
    },
  });

  await a.executar(evento());

  assert.equal(a.chamadas.some(([nome]) => nome === "concluir"), false);
  assert.equal(a.chamadas.some(([nome]) => nome === "incerta"), true);
});

test("consulta de recuperação não executa o agente", async () => {
  const a = ambiente({
    repo: {
      requisicao: async () => undefined,
    },
  });

  const entrada = evento();
  entrada.resource = "/conversas/{conversa_id}";
  entrada.httpMethod = "GET";
  entrada.pathParameters = { conversa_id: CONVERSA };
  entrada.queryStringParameters = { requisicao_id: REQUISICAO };

  const resposta = await a.executar(entrada);
  const corpo = JSON.parse(a.saida.join(""));

  assert.equal(resposta.statusCode, 200);
  assert.equal(corpo.requisicao.estado, "nao_recebida");
  assert.equal(corpo.requisicao.requisicao_id, REQUISICAO);
  assert.equal(a.chamadas.some(([nome]) => nome === "invocar"), false);
  assert.equal(a.chamadas.some(([nome]) => nome === "iniciar"), false);
});

test("consulta informa requisição concluída sem repetir a execução", async () => {
  const a = ambiente({
    repo: {
      obter: async () => ({ ...metadados(), versao: 1 }),
      requisicao: async () => ({
        estado: "concluida",
        versao: 1,
      }),
    },
  });

  const entrada = evento();
  entrada.resource = "/conversas/{conversa_id}";
  entrada.httpMethod = "GET";
  entrada.pathParameters = { conversa_id: CONVERSA };
  entrada.queryStringParameters = { requisicao_id: REQUISICAO };

  await a.executar(entrada);
  const corpo = JSON.parse(a.saida.join(""));

  assert.equal(corpo.requisicao.estado, "concluida");
  assert.equal(corpo.requisicao.versao, 1);
  assert.equal(a.chamadas.some(([nome]) => nome === "invocar"), false);
});
