import assert from "node:assert/strict";
import test from "node:test";

import { confirmedPaymentMethod } from "./payment-confirmation.mjs";

test("accepts one explicitly named payment method", () => {
  assert.equal(confirmedPaymentMethod("Confirmo o pagamento por cartão"), "cartao");
  assert.equal(confirmedPaymentMethod("Pode pagar via Pix"), "pix");
});

test("requires a single unambiguous method and rejects negation", () => {
  assert.equal(confirmedPaymentMethod("Pode ser Pix ou cartão"), null);
  assert.equal(confirmedPaymentMethod("Não quero pagar com Pix"), null);
  assert.equal(confirmedPaymentMethod("Não use cartão"), null);
});
