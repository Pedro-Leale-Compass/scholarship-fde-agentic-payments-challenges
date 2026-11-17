# Agente, Bedrock e tools — estado real e falhas conhecidas

Verificado contra o código em **2026-11-17** (baseline `v0.0.2`).

Este documento substitui as notas antigas de “grounding” que afirmavam correções que não
estão no código. O que vale é o comportamento descrito aqui e o plano em
[`PLAN-AGENT-REVAMP.md`](PLAN-AGENT-REVAMP.md).

## 1. Modelo

- Código: `agent/index.ts`.
- ID efetivo: `BEDROCK_MODEL_ID` do ambiente. O `.env` local usa
  `us.anthropic.claude-haiku-4-5-20251001-v1:0`.
- **Confirmado no runtime em 2026-11-17:** `luiz_henrique_agent-AD3mRGF7e9`, versão 12,
  `READY`, Haiku 4.5.
- Fallback do código: `global.amazon.nova-2-lite-v1:0` (`agent/index.ts:30`).
- O CDK lê `BEDROCK_MODEL_ID` do `.env` no synth/deploy e grava nas variáveis do runtime
  (`infra/lib/agent-stack.ts`). Um deploy feito sem `.env` usa Nova silenciosamente.
- `temperature: 0` está configurado, mas não garante determinismo absoluto.
- Região: `us-east-1`. O perfil `us.` é cross-region apenas nos EUA.

**Como confirmar o modelo vivo (sem invocar Bedrock):**

```bash
npm run check:model
```

O script usa `bedrock-agentcore-control get-agent-runtime` e imprime
`environmentVariables.BEDROCK_MODEL_ID`, status e versão do runtime. Leitura de control
plane não gera custo de Bedrock. O `infra/cdk.out/Desafio1Stack.template.json` também mostra
o valor do último synth, mas não prova o que está implantado.

A resposta do runtime também inclui o campo `model`; uma invocação de teste confirma o
modelo efetivo, mas consome tokens do Bedrock. Prefira `check:model` para a confirmação
sem custo.

## 2. Tools (contratos atuais)

### `listar_catalogo`

- Input: `{}`.
- Output: `{ ok, catalogo: [{ id, nome, preco }], count }`.
- Lambda: `tools/listar_catalogo/index.ts`, tabela `Catalogo`.

### `registrar_intencao`

- Input atual: `{ produtos: [{ id, nome, preco }], valor }`.
- Output ok: `{ ok, intencao_id, usuario_id, produtos, valor, valor_centavos, status,
  expira_em, message }`.
- O backend **confia** no `valor` e nos produtos enviados pelo modelo; ainda não resolve
  preço pelo catálogo.
- ID: `INT-XXXXXXXX` (8 hex maiúsculos), gerado por `randomBytes(4)`
  (`tools/registrar_intencao/index.ts:11-13`).
- Expiração: 15 minutos.
- Erros: `usuario_id` ausente, lista vazia ou valor inválido (400).

### `realizar_compra`

- Input: `{ intencao_id, forma_pagamento: "cartao" | "pix" }`.
- Output ok: `{ ok: true, code: "COMPRA_APROVADA", intencao_id, valor, valor_centavos,
  forma_pagamento, status: "paga" }`.
- Valida: existência, dono (`usuario_id`), status `pendente`, expiração e saldo.
- Transação: debita `Usuarios.limite_centavos` e marca `Intencoes.status = paga` numa única
  `TransactWriteItems`.
- Em `LIMITE_EXCEDIDO` e `INTENCAO_EXPIRADA`, cancela a intenção.
- Códigos atuais: `COMPRA_APROVADA`, `INTENCAO_INVALIDA`, `INTENCAO_JA_PAGA`,
  `INTENCAO_CANCELADA`, `INTENCAO_EXPIRADA`, `INTENCAO_INDISPONIVEL`, `LIMITE_EXCEDIDO`,
  `METODO_INVALIDO`, `USUARIO_NAO_ENCONTRADO`.
- `INTENCAO_JA_PAGA` só para `status = paga`; `cancelada` e `expirada` têm códigos próprios.
  `INTENCAO_INDISPONIVEL` cobre mudança concorrente de status.

## 3. Fluxo do runtime (atual, pós-remoção dos overrides)

1. A Lambda do chat envia `prompt`, `messages` e `usuario_id`. **Não envia mais**
   `intencao_id` nem persiste `Usuarios.ultima_intencao_id`.
2. O runtime cria um `Agent` novo por requisição. O estado começa com
   `registeredIntencaoId = null` e `registeredThisTurn = false`.
3. `registrar_intencao` só atualiza o estado quando o tool result tem `ok: true` e um
   `intencao_id` string. Esse é o único ID “novo” da invocação.
4. `realizar_compra` usa **exatamente** o `intencao_id` que o modelo passou. Não existe
   override para o “último ID”. ID malformado devolve `INTENCAO_INVALIDA`; ID válido mas
   terminal é decidido pelo backend (`INTENCAO_CANCELADA`, `INTENCAO_EXPIRADA`,
   `INTENCAO_JA_PAGA` ou `INTENCAO_INDISPONIVEL`).
5. Depois da resposta do modelo:
   - `stripFabricatedTurns` corta transcrições fabricadas;
   - `applyRegistrationGuard` substitui “intenção registrada” por uma falha visível se
     `registrar_intencao` não retornou `ok: true` nesta invocação;
   - `applyPurchaseGuard` impede afirmar sucesso sem `realizar_compra.ok === true`.
   - **Não existe** `groundIntencaoIds` nem `completePaymentFallback`.
6. A resposta inclui `registered_intencao_id` (ID criado nesta invocação, ou `null`) e
   `registered` (boolean). O campo `intencao_id` continua como alias do ID novo para
   compatibilidade, mas nunca é um ID antigo.
7. A API mantém as últimas 12 mensagens **sem filtrar falhas**: o modelo precisa ver que a
   intenção foi cancelada.

## 4. Falhas do `v0.0.2` e o que mudou

O transcript de `v0.0.2` reutilizou `INT-E36C946B` porque:

1. a API enviava `Usuarios.ultima_intencao_id` em todo turno;
2. a mensagem de falha era removida do histórico;
3. `groundIntencaoIds` reescrevia qualquer ID divergente para o ID antigo;
4. `realizar_compra` sobrescrevia o ID do modelo com o estado antigo;
5. o fallback de pagamento preferia o estado antigo;
6. não havia guarda de registro;
7. o exemplo do prompt usava `INT-1A2B3C4D`, que o modelo copiava;
8. `cancelada` era mascarado como `INTENCAO_JA_PAGA`.

Correções aplicadas no código:

- removidos `groundIntencaoIds`, `completePaymentFallback`, o seed de `ultima_intencao_id`
  e todos os overrides de ID;
- `registrar_intencao` só marca registro com `ok: true`;
- guarda de registro com falha visível;
- histórico não esconde mais a falha;
- códigos terminais separados (`INTENCAO_CANCELADA`, `INTENCAO_EXPIRADA`,
  `INTENCAO_JA_PAGA`, `INTENCAO_INDISPONIVEL`);
- exemplo do prompt sem ID concreto;
- `realizar_compra` devolve `409` com o status real quando a intenção não está `pendente`.

Ainda falta o estado por conversa (`conversa_id`). Sem ele, o modelo precisa chamar
`registrar_intencao` novamente ao escolher um produto novo; se omitir, a guarda mostra a
falha em vez de inventar um ID.

Evidência histórica do `v0.0.2` no log group
`/aws/bedrock-agentcore/runtimes/luiz_henrique_agent-AD3mRGF7e9-DEFAULT`:

- `Intenção INT-1A2B3C4D registrada` — o modelo copiou o ID do exemplo do prompt;
- `{"guard":"intencao_id_grounded","intencao_id":"INT-F8550A7B"}` — o runtime reescreveu;
- `INT-E36C946B` no DynamoDB com `status=cancelada`, `motivo_falha=LIMITE_EXCEDIDO`;
- `{"guard":"payment_fallback",...,"intencao_id":"INT-E36C946B","status":"cancelada"}`;
- `{"guard":"purchase_reply_adjusted","purchase":{"ok":false,"code":"INTENCAO_JA_PAGA"}}`.

Esses eventos são históricos: os guards `intencao_id_grounded` e `payment_fallback` não
existem mais.

## 5. O que ainda NÃO está implementado

- Estado por conversa (`conversa_id`) no caminho de checkout.
- `registrar_intencao` resolvendo preço pelo catálogo.
- Persistência de histórico em `Conversas`.
- Streaming/WebSocket.
- Validação na stack implantada desta rodada (o fluxo local já passou).

Logs do runtime **estão confirmados** no CloudWatch (runtime v12, 2026-11-17); ver
`OPERATIONS.md`.

## 6. Paridade local/remota

O agente local roda o **mesmo** `agent/index.ts` e o mesmo modelo Bedrock. Com ARNs
configurados, chama as mesmas Lambdas. Sem ARNs, usa o fallback em memória.

Desde esta rodada, o fallback local replica:

- ID `INT-XXXXXXXX`;
- `code`/`status`/`valor_centavos`/`expira_em`;
- cancelamento em `LIMITE_EXCEDIDO` e `INTENCAO_EXPIRADA`;
- saldo por usuário (não limite por compra).

O que o local **não** exercita: API Gateway, JWT, CORS, DynamoDB real, IAM, imagem Docker,
sessão do AgentCore e logs do runtime. Para iterar prompt/tool loop, é simétrico o
suficiente; para validar persistência, use a stack implantada.

O harness `npm run test:local` sobe o agente, executa o transcript de regressão
(monitor → `LIMITE_EXCEDIDO` → fone → pix) e falha se o ID antigo reaparecer. Ele carrega o
`.env` da raiz e prefere credenciais estáticas do `aws-creds.sh` ao `AWS_PROFILE` do `.env`.

## 7. Próximo passo

Ver [`PLAN-AGENT-REVAMP.md`](PLAN-AGENT-REVAMP.md). Em resumo: remover o ID do payload,
usar estado por conversa, só aceitar ID de tool result, remover `groundIntencaoIds`, separar
códigos e cobrir o transcript atual com teste de regressão.
