/**
 * Fluxo local do agente (sem API Gateway): mantém a conversa em memória e
 * exercita o mesmo agent/index.ts do runtime. Por padrão usa o fallback local
 * das tools; com USE_REAL_TOOLS=1 usa as Lambdas implantadas.
 *
 * Pré-requisito: agente local rodando em AGENT_LOCAL_URL (padrão :3031).
 * Normalmente executado por `npm run test:local`.
 */

const BASE = process.env.AGENT_LOCAL_URL || 'http://localhost:3031';
const USER = process.env.LOCAL_USER_ID || `local-flow-${Date.now()}`;
const SESSION = `local-flow-${Date.now()}`;
const EXPECT_MODEL = process.env.EXPECT_MODEL || '';

const messages = [];
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

async function say(text) {
  messages.push({ role: 'user', content: [{ text }] });
  const res = await fetch(`${BASE}/invocations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-amzn-bedrock-agentcore-runtime-session-id': SESSION,
    },
    body: JSON.stringify({ prompt: text, usuario_id: USER, messages }),
  });
  const raw = await res.text();
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new Error(`resposta não-JSON (${res.status}): ${raw.slice(0, 500)}`);
  }
  const payload =
    envelope && typeof envelope.body === 'object' && envelope.body !== null
      ? envelope.body
      : envelope;

  if (payload.statusCode && payload.statusCode >= 400) {
    throw new Error(
      `erro do agente (${payload.statusCode} ${payload.code || ''}): ${payload.error || ''}`,
    );
  }

  const reply = payload.reply ?? '(sem reply)';
  console.log(`\nUSER: ${text}`);
  console.log(`REPLY: ${reply}`);
  console.log(
    `META: ${JSON.stringify({
      purchase: payload.purchase,
      registered_intencao_id: payload.registered_intencao_id,
      registered: payload.registered,
      model: payload.model,
    })}`,
  );
  messages.push({ role: 'assistant', content: [{ text: reply }] });
  return payload;
}

const first = await say(
  'Quero comprar o Monitor 27". Apenas registre a intenção; não finalize.',
);
const second = await say('Pode confirmar o pagamento com cartão.');
const third = await say(
  'Quero comprar o Fone Bluetooth. Apenas registre a intenção; não finalize.',
);
const fourth = await say('Pix.');

const firstId = first.registered_intencao_id;
const thirdId = third.registered_intencao_id;

check(/^INT-[0-9A-F]{8}$/.test(firstId || ''), `primeiro ID inválido: ${firstId}`);
check(
  second.purchase?.ok === false &&
    second.purchase?.code === 'LIMITE_EXCEDIDO' &&
    second.purchase?.status === 'cancelada',
  `esperava LIMITE_EXCEDIDO/cancelada; veio ${JSON.stringify(second.purchase)}`,
);
check(
  /^INT-[0-9A-F]{8}$/.test(thirdId || ''),
  `segundo ID inválido: ${thirdId}`,
);
check(
  firstId && thirdId && firstId !== thirdId,
  `ID reutilizado: primeiro=${firstId}, segundo=${thirdId}`,
);
check(
  fourth.purchase?.ok === true &&
    fourth.purchase?.code === 'COMPRA_APROVADA' &&
    fourth.purchase?.status === 'paga',
  `esperava COMPRA_APROVADA/paga; veio ${JSON.stringify(fourth.purchase)}`,
);
check(
  !firstId || (!third.reply.includes(firstId) && !fourth.reply.includes(firstId)),
  `resposta citou o ID antigo ${firstId}`,
);
check(
  !fourth.reply.includes('INT-1A2B3C4D'),
  'resposta citou o ID de exemplo do prompt',
);
check(third.registered === true, 'terceiro turno não registrou uma nova intenção');
check(fourth.registered !== true, 'quarto turno não deveria registrar nova intenção');

const model = fourth.model || '';
if (!model) {
  failures.push('resposta não informou o modelo');
} else if (EXPECT_MODEL && !model.includes(EXPECT_MODEL)) {
  failures.push(`modelo ${model} não contém ${EXPECT_MODEL}`);
} else if (!model.includes('claude-haiku-4-5')) {
  console.warn(`\nAVISO: modelo local é ${model} (não é Claude Haiku 4.5)`);
}

console.log('\nRESUMO');
console.log(
  JSON.stringify(
    {
      user: USER,
      model,
      firstId,
      thirdId,
      secondPurchase: second.purchase,
      fourthPurchase: fourth.purchase,
      failures,
    },
    null,
    2,
  ),
);

if (failures.length > 0) {
  console.error(`\nFALHOU (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('\nOK: nova compra após cancelamento criou um novo ID e pagou.');
}
