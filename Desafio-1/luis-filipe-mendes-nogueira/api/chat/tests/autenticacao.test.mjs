import test from "node:test";
import assert from "node:assert/strict";
import {
  expiracaoEmSegundos,
  identidade,
} from "../src/autenticacao.mjs";

function formatoRest(instante) {
  const [semana, dia, mes, ano, hora] =
    new Date(instante).toUTCString().split(" ");

  return `${semana.replace(",", "")} ${mes} ${dia} ${hora} UTC ${ano}`;
}

function evento(exp, extras = {}) {
  return {
    requestContext: {
      authorizer: {
        claims: {
          sub: "usuario-autenticado",
          client_id: "client-teste",
          token_use: "access",
          exp,
          ...extras,
        },
      },
    },
  };
}

function recusada(entrada) {
  assert.throws(
    () => identidade(entrada, "client-teste"),
    (erro) =>
      erro.status === 401 &&
      erro.codigo === "SESSAO_INVALIDA",
  );
}

test("aceita expiração numérica e string numérica", () => {
  const futuro = Math.floor(Date.now() / 1000) + 300;

  for (const exp of [futuro, String(futuro)]) {
    assert.equal(
      identidade(evento(exp), "client-teste"),
      "usuario-autenticado",
    );
  }
});

test("aceita data UTC entregue pelo autorizador REST", () => {
  const futuro = Date.now() + 300_000;

  assert.equal(
    identidade(evento(formatoRest(futuro)), "client-teste"),
    "usuario-autenticado",
  );
});

test("converte data UTC sem depender do fuso local", () => {
  assert.equal(
    expiracaoEmSegundos("Mon Nov 16 16:00:00 UTC 2026"),
    Date.UTC(2026, 10, 16, 16, 0, 0) / 1000,
  );
});

test("recusa sessão expirada nos dois formatos", () => {
  const passado = Date.now() - 60_000;

  recusada(evento(Math.floor(passado / 1000)));
  recusada(evento(formatoRest(passado)));
});

test("continua recusando client diferente e ID token", () => {
  const futuro = formatoRest(Date.now() + 300_000);

  recusada(evento(futuro, { client_id: "outro-client" }));
  recusada(evento(futuro, { token_use: "id" }));
  recusada(evento(futuro, { sub: "" }));
  recusada({});
});

test("recusa formatos inválidos e datas impossíveis", () => {
  for (const valor of [
    null,
    undefined,
    true,
    {},
    "",
    "data-invalida",
    "Mon Nov 32 16:00:00 UTC 2026",
    "Mon Nov 16 25:00:00 UTC 2026",
  ]) {
    assert.equal(Number.isNaN(expiracaoEmSegundos(valor)), true);
    recusada(evento(valor));
  }
});
