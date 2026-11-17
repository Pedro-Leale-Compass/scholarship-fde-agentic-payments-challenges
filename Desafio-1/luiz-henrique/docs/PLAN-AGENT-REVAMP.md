# Plano — revisão do agente e estado autoritativo da intenção

- **Status:** proposto em 2026-11-17
- **Baseline:** tag `v0.0.2` — “chat works sometimes” (commit `d854762`)
- **Escopo:** agente, API, tools, dados, testes, observabilidade e documentação
- **Fora de escopo nesta rodada:** painel admin, streaming/WebSocket, S3/CloudFront,
  novos serviços pagos

## 1. Problema observado

Em uma conversa real:

1. `comrpar monitor` → `registrar_intencao` cria `INT-E36C946B`.
2. `cartao` → `LIMITE_EXCEDIDO`; a intenção é cancelada no DynamoDB.
3. `comprar fone` → o agente **não** chama `registrar_intencao`, mas responde “Intenção
   INT-E36C946B registrada: Fone...”. O ID é o do monitor.
4. `pix` → o runtime tenta pagar `INT-E36C946B`; o backend responde `INTENCAO_JA_PAGA`.

O problema não é o modelo escolhido. O runtime tem três fontes concorrentes para “intenção
atual” e resolve conflitos a favor da mais antiga:

- `Usuarios.ultima_intencao_id` (persistido, por usuário, nunca invalidado) —
  `api/index.ts:186`, `api/index.ts:252-256`;
- estado mutável do callback (`state.lastIntencaoId`) — `createAgent` (`agent/index.ts:353-359`),
  callback de `registrar_intencao` e callback de `realizar_compra` (`agent/index.ts:409-421`);
- texto do modelo, reescrito por `groundIntencaoIds` (`agent/index.ts:553-574`).

Além disso, a mensagem de falha é removida do histórico (`api/index.ts:200-208`), então o
modelo vê uma intenção “pendente” do monitor e nenhum registro do cancelamento. Ele trata
“comprar fone” como troca do item da mesma intenção. O runtime então “conserta” o ID para o
valor antigo, fabricando uma resposta que parece legítima.

### 1.1 Evidência nos logs e no DynamoDB (2026-11-17)

Runtime confirmado: `luiz_henrique_agent-AD3mRGF7e9`, versão 12, `READY`,
`BEDROCK_MODEL_ID=us.anthropic.claude-haiku-4-5-20251001-v1:0`.
Log group: `/aws/bedrock-agentcore/runtimes/luiz_henrique_agent-AD3mRGF7e9-DEFAULT`.

Eventos observados:

- o modelo copiou o ID do exemplo do prompt: `Intenção INT-1A2B3C4D registrada: ...`;
- o runtime reescreveu para um ID “real”:
  `{"guard":"intencao_id_grounded","intencao_id":"INT-F8550A7B"}`;
- `INT-E36C946B` no DynamoDB: `status=cancelada`, `motivo_falha=LIMITE_EXCEDIDO`,
  `cancelada_em=2026-11-17T17:54:39.180Z`;
- o fallback tentou pagar o ID cancelado:
  `{"guard":"payment_fallback","purchase":{"ok":false,"code":"LIMITE_EXCEDIDO","intencao_id":"INT-E36C946B","status":"cancelada"}}`;
- a resposta foi ajustada:
  `{"guard":"purchase_reply_adjusted","purchase":{"ok":false,"code":"INTENCAO_JA_PAGA"}}`.

Isso fecha a causa: o ID antigo não veio de uma nova `registrar_intencao`; ele foi
reintroduzido pelo estado/grounding e aceito pelo fallback.

## 2. Princípios de projeto

1. **O backend é a única fonte de verdade** sobre identidade, status, preço e ciclo de vida.
   O modelo propõe ações; ele não carrega estado autoritativo.
2. **IDs só nascem de tool results.** Um `intencao_id` só pode ser usado se veio de um
   `registrar_intencao` bem-sucedido na mesma invocação (ou de estado persistido validado
   como `pendente`).
3. **Nunca “groundar” um ID errado para outro.** ID divergente é erro, não correção
   silenciosa. A resposta deve dizer que o registro não aconteceu e refazer o fluxo.
4. **Estado por conversa, não por usuário.** Abrir um chat novo não pode herdar a intenção
   de um chat antigo.
5. **Tools idempotentes e com transições explícitas:**
   `pendente → paga | cancelada | expirada`.
6. **Contratos iguais local/remoto.** O fallback local replica IDs, códigos, status,
   expiração e saldo das Lambdas.
7. **Sem novos serviços pagos.** DynamoDB on-demand, Lambda, API Gateway, AgentCore e
   CloudWatch Logs já existem. Não criar VPC/NAT, CloudFront, Amplify Hosting nem jobs.
8. **Documentação verificável.** Todo doc canônico declara data de verificação e aponta
   para o código. Docs históricos vão para `docs/archive/`.

## 3. Arquitetura alvo

```
Frontend
  └─ cria/guarda conversa_id (UUID no navegador)
     └─ POST /chat { conversa_id, messages }
          └─ Lambda do chat
               ├─ valida JWT (sub)
               ├─ carrega/cria estado da conversa em Conversas
               ├─ envia ao runtime: { usuario_id, conversa_id, messages }
               └─ grava o estado retornado (pending_intencao_id, status)
                    └─ AgentCore Runtime
                         ├─ registrar_intencao({ itens: [{ produto_id, quantidade }] })
                         │    └─ backend resolve catálogo, preço e cria intenção
                         ├─ realizar_compra({ intencao_id, forma_pagamento })
                         │    └─ backend valida dono/status/expiração/saldo
                         └─ resposta factual renderizada a partir do tool result
```

### 3.1 Estado da conversa

Item em `Conversas` (PK `conversa_id`, SK `usuario_id`):

```json
{
  "conversa_id": "uuid",
  "usuario_id": "sub",
  "pending_intencao_id": "INT-XXXXXXXX",
  "pending_status": "pendente",
  "updated_at": "2026-11-17T18:00:00Z"
}
```

Regras:

- `pending_intencao_id` só é gravado após `registrar_intencao` retornar `ok: true`.
- É limpo quando a intenção vira `paga`, `cancelada` ou `expirada`.
- É lido no início do turno apenas se o status no DynamoDB ainda for `pendente` e não
  expirado. Caso contrário, é tratado como ausente.
- `Usuarios.ultima_intencao_id` é **descontinuado**. Manter o campo por compatibilidade
  até a migração, mas não usá-lo para decidir pagamento.

### 3.2 Runtime sem estado global

Remover:

- `intencao_id` do payload da API para o runtime (`api/index.ts:221`);
- seed de `state.lastIntencaoId` a partir do payload (`createAgent`, `agent/index.ts:353-359`);
- override incondicional em `realizar_compra` (`agent/index.ts:409-421`);
- `groundIntencaoIds` (`agent/index.ts:553-574`);
- fallback que prefere `state.lastIntencaoId` (`agent/index.ts:330`).

Adicionar:

- `state.registeredThisTurn: boolean` e `state.verifiedPendingId: string | null`;
- guarda de registro: se a resposta contém “registrada/registrado” e
  `registeredThisTurn === false`, substituir por mensagem explícita de que o registro não
  ocorreu e chamar/forçar `registrar_intencao`;
- guarda de compra (manter): sucesso só com `realizar_compra.ok === true`;
- fallback de pagamento apenas quando:
  - existe `verifiedPendingId` de uma intenção `pendente` verificada;
  - a última mensagem do usuário é uma confirmação explícita de pagamento;
  - a mensagem não é de um turno de troca de produto.
- Se o modelo passar um `intencao_id` diferente do `verifiedPendingId`, devolver
  `INTENCAO_INVALIDA` e pedir novo registro. Não trocar o ID silenciosamente.

### 3.3 Contrato das tools

`registrar_intencao`:

```json
// input
{ "itens": [{ "produto_id": "p1", "quantidade": 1 }] }
// output ok
{ "ok": true, "intencao_id": "INT-XXXXXXXX", "valor": 199.9,
  "valor_centavos": 19990, "status": "pendente", "expira_em": "..." }
```

O backend resolve nome e preço no catálogo. O modelo não envia `valor` nem `nome`.
Preço divergente do catálogo vira `PRODUTO_INVALIDO`/`VALOR_INVALIDO`.

`realizar_compra`:

```json
// input
{ "intencao_id": "INT-XXXXXXXX", "forma_pagamento": "cartao" }
```

Códigos: `COMPRA_APROVADA`, `INTENCAO_INVALIDA`, `INTENCAO_JA_PAGA`,
`INTENCAO_CANCELADA`, `INTENCAO_EXPIRADA`, `LIMITE_EXCEDIDO`, `METODO_INVALIDO`,
`USUARIO_NAO_ENCONTRADO`, `PRODUTO_INVALIDO`.

`INTENCAO_JA_PAGA` deve ser usado só para `status = paga`. Para `cancelada`, use
`INTENCAO_CANCELADA`; para expirada, `INTENCAO_EXPIRADA`. Isso evita a mensagem enganosa
do transcript.

### 3.4 Prompt e few-shot

- Remover ID concreto do exemplo (`INT-1A2B3C4D`) ou trocar por `<ID_RETORNADO>`.
- Regras explícitas:
  - produto novo ⇒ nova intenção; nunca reaproveitar intenção paga/cancelada/expirada;
  - não afirmar “registrada” sem tool result;
  - em caso de dúvida sobre o status, registrar de novo;
  - não pedir/aceitar `usuario_id`, preço ou forma de pagamento fora do fluxo.
- Não depender de “uma ferramenta por vez”: o estado do runtime deve tolerar chamadas
  paralelas sem usar a ordem dos callbacks como verdade.

## 4. Fases e critérios de aceite

### Fase 0 — Baseline e documentação (feita)

- [x] Tag `v0.0.2` “chat works sometimes”.
- [x] Diagnóstico registrado neste plano.
- [x] Docs canônicos e arquivo histórico separados (esta rodada).
- [x] `AGENTS.md` atualizado com estado real, custos e comandos.

### Fase 1 — Paridade local/remota (feita nesta rodada)

- [x] Fallback local gera `INT-XXXXXXXX` (não `int-...`).
- [x] Fallback local devolve `code`, `status`, `valor_centavos`, `expira_em`.
- [x] Fallback local cancela em `LIMITE_EXCEDIDO`/`INTENCAO_EXPIRADA`.
- [x] Fallback local mantém saldo por usuário (não limite por compra).
- [x] `npx tsc --noEmit` no `agent/` passa.
- Critério: um teste local sem ARNs reproduz o mesmo contrato das Lambdas.

### Fase 2 — Observabilidade sem custo novo

- [x] `npm run check:model`: lê `BEDROCK_MODEL_ID` do runtime via control plane (read-only).
- [x] `npm run check:logs`: lista log groups/streams do agente e das tools (read-only).
- [x] Rodar os dois comandos: runtime v12 `READY`, Haiku 4.5; resultado em
      `docs/OPERATIONS.md`.
- [x] Confirmar o grupo
      `/aws/bedrock-agentcore/runtimes/luiz_henrique_agent-AD3mRGF7e9-DEFAULT` e os grupos
      `/aws/lambda/luiz-henrique-*` (2026-11-17).
- Critério: saber, sem invocar Bedrock, qual modelo está no runtime e onde estão os logs.

### Fase 3 — Estado autoritativo da conversa

- [ ] Adicionar `conversa_id` ao payload do frontend e à Lambda do chat.
- [ ] Criar/ler item em `Conversas` com `pending_intencao_id`/`pending_status`.
- [x] Remover `ultima_intencao_id` do caminho de decisão.
- [x] Remover seed/override/grounding descritos em §3.2.
- [x] Implementar guarda de registro; fallback de pagamento removido.
- [ ] Limpar estado em `paga`/`cancelada`/`expirada`.
- Critério: duas compras consecutivas (mesmo após falha) geram IDs distintos; nova
  conversa não herda ID; ID inválido nunca é “corrigido” para outro.

### Fase 4 — Tools e modelo de dados

- [ ] `registrar_intencao` recebe `itens` e resolve preço no catálogo.
- [ ] Adicionar `conversa_id`, `motivo_falha`, `cancelada_em` em `Intencoes`.
- [ ] Separar códigos `INTENCAO_CANCELADA`/`INTENCAO_EXPIRADA`/`INTENCAO_JA_PAGA`.
- [ ] Ajustar IAM mínimo para os novos acessos.
- [x] Parar de ler/escrever `Usuarios.ultima_intencao_id`; campo permanece legado.
- Critério: preço e produto sempre vêm do catálogo; status terminais são explícitos.

### Fase 5 — Prompt, testes e evidências

- [ ] Reescrever o system prompt conforme §3.4.
- [ ] Adicionar cenários de regressão:
  1. compra cartão ok;
  2. compra pix ok;
  3. limite excedido → novo produto deve criar novo ID;
  4. compra paga → novo produto deve criar novo ID;
  5. ID inválido → `INTENCAO_INVALIDA`;
  6. expirada → `INTENCAO_EXPIRADA`;
  7. registro fabricado → guarda;
  8. duas conversas isoladas;
  9. duas abas na mesma conversa;
  10. chamadas de tool em paralelo.
- [x] Rodar `npm run test:local` (fallback, Haiku) — passou.
- [ ] Rodar `npm run test:agent` na stack implantada após o deploy.
- [ ] Capturar evidências para o README.
- Critério: suíte falha se um ID de uma compra anterior aparecer em uma compra nova.

### Fase 6 — Rollout e custos

- [ ] `cdk diff` antes do deploy; conferir que não há recursos novos pagos.
- [ ] Deploy único; confirmar runtime `READY` e `npm run check:model`.
- [ ] Rodar smoke tests; conferir logs.
- [ ] Monitorar o orçamento de US$ 20 (US$ 5 já gastos). Evitar chamadas repetidas ao
      Bedrock; usar o fallback local para iterar prompt.
- Critério: nenhum serviço novo; custo incremental apenas de chamadas Bedrock de teste.

## 5. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Migração de `ultima_intencao_id` quebrar usuários existentes | Manter o campo, parar de lê-lo; backfill opcional por conversa |
| Fallback local divergir das Lambdas | Contratos em um módulo compartilhado ou testes de contrato |
| Guarda bloquear compra legítima | Guarda só atua quando há afirmação factual sem tool result; testar fraseado |
| Custo de testes com Bedrock | Usar fallback local para loop; limitar chamadas; orçamento |
| Deploy demorado/ECR | Fazer uma vez por fase; `cdk diff` antes |
| Logs ausentes | `check:logs` read-only; documentar limitação sem criar recursos |

## 6. Decisões abertas

1. `conversa_id` gerado no frontend (localStorage) ou no backend no primeiro turno?
2. Persistir histórico completo de mensagens em `Conversas` agora (requisito do PDF) ou só
   o estado de checkout?
3. Manter `registrar_intencao` separado ou unificar em um tool `checkout`?
4. Como cumprir o requisito “Stream ou WebSocket” sem aumentar custo?
5. Quando convidar o instrutor e congelar a aplicação para correção.

## 7. Definição de pronto

- Nenhuma resposta cita ID que não veio de tool result ou estado validado.
- Nenhuma compra usa intenção paga/cancelada/expirada.
- Nova conversa não herda intenção.
- Modelo e logs confirmáveis por comandos read-only.
- Docs canônicos sem afirmações não verificadas; históricos em `docs/archive/`.
- Suíte de regressão cobre o transcript de `v0.0.2` e passa.
