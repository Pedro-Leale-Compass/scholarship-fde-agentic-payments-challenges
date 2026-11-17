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
  `INTENCAO_EXPIRADA`, `LIMITE_EXCEDIDO`, `METODO_INVALIDO`, `USUARIO_NAO_ENCONTRADO`.
- **Problema:** qualquer status diferente de `pendente` (inclusive `cancelada`) vira
  `INTENCAO_JA_PAGA` (`tools/realizar_compra/index.ts:145-148`). Isso engana o usuário.

## 3. Fluxo do runtime (atual)

1. A Lambda do chat monta `prompt` (texto achatado) e `messages` estruturados, e envia
   `intencao_id` persistido em `Usuarios.ultima_intencao_id` (`api/index.ts:214-228`).
2. O runtime cria um `Agent` novo por requisição. O histórico vem de `messages`; o `prompt`
   é usado pelo fallback de pagamento.
3. `createAgent` inicializa `state.lastIntencaoId` com o `intencao_id` recebido
   (`createAgent`, `agent/index.ts:353-359`).
4. `registrar_intencao` atualiza `state.lastIntencaoId` quando retorna um ID.
5. `realizar_compra` **sobrescreve** qualquer ID do modelo com `state.lastIntencaoId` se ele
   existir (`realizar_compra` callback, `agent/index.ts:409-421`).
6. Depois da resposta do modelo:
   - `stripFabricatedTurns` corta transcrições fabricadas;
   - `groundIntencaoIds` troca qualquer ID divergente pelo “real”
     (`groundIntencaoIds`, `agent/index.ts:553-574`);
   - `applyPurchaseGuard` impede afirmar sucesso sem `realizar_compra.ok === true`;
   - `completePaymentFallback` tenta pagar se a última linha do usuário parecer confirmação
     e o modelo não tiver chamado a tool (`completePaymentFallback`, `agent/index.ts:313-347`).
7. A resposta sempre inclui `intencao_id: state.lastIntencaoId`, mesmo quando nenhuma
   intenção nova foi criada (`agent/index.ts:685`). A API persiste esse valor
   (`api/index.ts:252-256`).

## 4. Falhas conhecidas (por que o transcript reutiliza ID)

1. **`ultima_intencao_id` é por usuário e nunca é invalidado.** Depois de uma compra paga ou
   cancelada, o ID antigo continua sendo enviado em todo turno. Um chat novo herda o ID.
2. **O histórico remove a mensagem de falha.** A API filtra respostas que contêm
   “Nenhuma cobrança foi confirmada” (`api/index.ts:200-208`). O modelo deixa de ver que a
   intenção foi cancelada e trata o novo produto como troca da intenção antiga.
3. **`groundIntencaoIds` fabrica a resposta.** Se o modelo copia o ID do exemplo
   `INT-1A2B3C4D`, usa um placeholder ou inventa outro, o runtime troca pelo ID antigo. A
   resposta “Intenção ... registrada” passa a parecer verdadeira.
4. **`realizar_compra` ignora o ID correto do modelo.** Mesmo que o modelo passe um ID novo
   válido, o callback usa `state.lastIntencaoId` se ele existir.
5. **Fallback de pagamento usa estado antigo primeiro.** `state.lastIntencaoId ||
   ids[último]` (`agent/index.ts:330`) nunca prefere um ID novo do prompt quando há
   estado persistido.
6. **Não existe guarda de registro.** Só o sucesso de compra é verificado; “intenção
   registrada” sem tool result passa.
7. **O prompt atual não proíbe reutilizar intenção terminal.** O exemplo usa um ID concreto
   (`agent/index.ts:481-486`), o que favorece cópia.
8. **“Uma ferramenta por vez” é só texto.** O SDK pode emitir chamadas em paralelo; a ordem
   dos callbacks não é uma garantia de estado.
9. **Status terminal é mascarado.** `cancelada` vira `INTENCAO_JA_PAGA`.
10. **A mensagem de fallback sempre diz “continua pendente”** (`agent/index.ts:305`), mesmo
    quando o backend cancelou.

Evidência de 2026-11-17 no log group
`/aws/bedrock-agentcore/runtimes/luiz_henrique_agent-AD3mRGF7e9-DEFAULT`:

- `Intenção INT-1A2B3C4D registrada` — o modelo copiou o ID do exemplo do prompt;
- `{"guard":"intencao_id_grounded","intencao_id":"INT-F8550A7B"}` — o runtime reescreveu;
- `INT-E36C946B` no DynamoDB com `status=cancelada`, `motivo_falha=LIMITE_EXCEDIDO`;
- `{"guard":"payment_fallback",...,"intencao_id":"INT-E36C946B","status":"cancelada"}`;
- `{"guard":"purchase_reply_adjusted","purchase":{"ok":false,"code":"INTENCAO_JA_PAGA"}}`.

## 5. O que NÃO está implementado

- Estado por conversa (`conversa_id`) no caminho de checkout.
- `registrar_intencao` resolvendo preço pelo catálogo.
- Código distinto `INTENCAO_CANCELADA`.
- Guarda de registro.
- Persistência de histórico em `Conversas`.
- Streaming/WebSocket.

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

## 7. Próximo passo

Ver [`PLAN-AGENT-REVAMP.md`](PLAN-AGENT-REVAMP.md). Em resumo: remover o ID do payload,
usar estado por conversa, só aceitar ID de tool result, remover `groundIntencaoIds`, separar
códigos e cobrir o transcript atual com teste de regressão.
