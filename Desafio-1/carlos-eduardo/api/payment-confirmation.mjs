export function confirmedPaymentMethod(message) {
  const normalized = message
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  const methods = [];

  if (
    /\bpix\b/.test(normalized) &&
    !/\b(?:nao|nunca)\b.{0,32}\bpix\b/.test(normalized)
  ) {
    methods.push("pix");
  }
  if (
    /\b(?:cartao|credito|debito)\b/.test(normalized) &&
    !/\b(?:nao|nunca)\b.{0,32}\b(?:cartao|credito|debito)\b/.test(normalized)
  ) {
    methods.push("cartao");
  }
  return methods.length === 1 ? methods[0] : null;
}
