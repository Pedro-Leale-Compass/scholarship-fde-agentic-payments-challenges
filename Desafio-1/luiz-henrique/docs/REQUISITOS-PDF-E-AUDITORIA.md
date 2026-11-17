# Requisitos do PDF × estado atual

Verificado em **2026-11-17** contra o código e os outputs da stack. Baseline `v0.0.2`.

Legenda: ✅ atende · 🟡 parcial · ❌ não atende · ⏸ adiado por decisão explícita.

## 1. Stack e arquitetura

| Requisito | Estado | Evidência/observação |
|---|---|---|
| Migrar o chatbot da Fase 1 para AWS | ✅ | `api/`, `agent/`, `tools/`, `infra/` |
| Manter regras de negócio (catálogo, intenção, cartão/Pix, limite) | 🟡 | fluxo existe; há bug de reutilização de `intencao_id` (ver §4) |
| Tudo em `us-east-1`; prefixo `luiz-henrique` | ✅ | `infra/bin/desafio-1.ts`, `database-stack.ts` |
| Comunicação frontend ↔ backend via API Gateway | ✅ | `POST /chat` com JWT Cognito |
| Frontend S3 privado + CloudFront + OAC com URL pública | ❌/⏸ | frontend roda local; não existe `FrontendStack` |
| `config.json` gerado pelo IaC no deploy | 🟡 | `frontend/public/config.json` é versionado; `scripts/dev-frontend-local.sh` regenera a partir de `cdk-outputs.json` quando presente |
| Cognito + `Authenticator`, `hideSignUp`, sem auto cadastro | ✅ | `frontend/app/page.tsx:60`; `infra/lib/api-stack.ts` |
| API Gateway + autorizador JWT | ✅ | `infra/lib/api-stack.ts` |
| API “Stream ou WebSocket” | ❌ | REST não-streaming |
| Strands no AgentCore Runtime + Bedrock | ✅ | `agent/index.ts`; runtime via `CustomResource`; Haiku 4.5 no runtime v12 (2026-11-17) |
| 3 tools em Lambda | ✅ | `tools/` + `infra/lib/tools-stack.ts` |
| DynamoDB: usuários+limite, conversas, intenções | 🟡 | `Usuarios`/`Intencoes`/`Catalogo` em uso; `Conversas` existe mas não é gravada |
| IaC com um comando para o ambiente completo, incluindo frontend | 🟡 | `npm run deploy:api-agent` cobre backend/agente; frontend fica local |

## 2. Segurança e regras de compra

| Requisito | Estado | Observação |
|---|---|---|
| Sem token → `401` no API Gateway | ✅ | authorizer Cognito; teste em `tests/agent.test.mjs` |
| `usuario_id` vem do `sub` do token, nunca do corpo/modelo | ✅/🟡 | o chat extrai do token e envia ao runtime; as tools confiam no payload do runtime (IAM restrito) |
| Valor da compra vem da intenção salva | ✅ | `realizar_compra` lê `Intencoes.valor_centavos` |
| Só paga intenção do próprio usuário, `pendente`, não expirada | ✅ | `tools/realizar_compra/index.ts` |
| Pagamento/limite sem duplicidade (condicional/transação) | ✅ | `TransactWriteItems` com `status = pendente` e `limite_centavos >= valor` |
| IAM de menor privilégio, sem `*`/`AdministratorAccess` | 🟡 | exceção documentada: `ecr:GetAuthorizationToken` com `*`; `AWSLambdaBasicExecutionRole` no runtime |
| Nenhum segredo no Git | ✅ | `.env`/`cdk-outputs.json`/`postman-environment.json` ignorados |
| CORS restrito à origem do frontend | ✅ | `FRONTEND_URL`/`frontendUrl` = `http://localhost:3000` |

## 3. Entrega e operação

| Requisito | Estado | Observação |
|---|---|---|
| README com diagrama, deploy, modelo, DynamoDB, IAM e remoção | 🟡 | atualizado nesta rodada; evidências ainda pendentes |
| Evidências: login, 401, cartão, Pix, limite, ID inválido | ❌ | nenhuma captura anexada ainda |
| Aplicação no ar até a correção | ❌/⏸ | frontend local; falta convidar o instrutor e manter a API acessível |
| Usuário do instrutor no Cognito | ❌ | usar `npm run user:invite -- <email> [limite]` |
| Alerta de orçamento | 🟡 | orçamento de US$ 20 mencionado (≈US$ 5 gastos); não há registro neste repo de alarme criado. Criar AWS Budget é gratuito (primeiros 2); se já existir, registre o ID/limite aqui |
| Destroy + limpeza | ✅ | `npm run destroy` + `scripts/destroy-cleanup.sh` + `destroy-cleanup.md` |
| Extras (MCP Gateway, Memory, Guardrails, traces) | ⏸ | não previstos |

## 4. Defeito conhecido que afeta a correção

A conversa de `v0.0.2` reutiliza `INT-E36C946B` ao comprar outro produto depois de um
`LIMITE_EXCEDIDO`. Causa e correção proposta estão em
[`PLAN-AGENT-REVAMP.md`](PLAN-AGENT-REVAMP.md). Resumo:

- `Usuarios.ultima_intencao_id` é por usuário, nunca é invalidado e é enviado em todo turno;
- o histórico remove a mensagem de falha, então o modelo não sabe que a intenção foi
  cancelada;
- `groundIntencaoIds` troca qualquer ID divergente pelo ID antigo;
- `realizar_compra` sobrescreve o ID do modelo com o estado antigo;
- `INTENCAO_JA_PAGA` é usado para `cancelada`, mascarando o status real.

Enquanto o plano não for implementado, não trate o fluxo de compra como confiável para
evidência de “compra com cartão/Pix” em sequência.

## 5. Desvio autorizado: frontend local

Decisão: frontend em `http://localhost:3000`; API, agente e banco na AWS.

Motivo: a conta tem SCP que bloqueia S3/CloudFront/OAC nesta rodada. Consequências:

- não há URL pública de frontend;
- `config.json` é versionado com identificadores públicos;
- o CORS aceita apenas `http://localhost:3000`;
- o critério “aplicação no ar” fica parcial.

O instrutor deve rodar:

```bash
git clone <repo>
cd Desafio-1/luiz-henrique
npm run setup
npm run dev
```

## 6. Convenção de pasta

O PDF usa `fellows/<seu-nome>/`; o repositório usa `Desafio-1/<seu-nome>/`. A entrega segue
a convenção do repositório. A divergência fica registrada aqui e no `README.md`; não é
corrigida localmente.

## 7. Pendências priorizadas

1. Implementar o `PLAN-AGENT-REVAMP.md` (estado por conversa, sem grounding, códigos
   corretos).
2. Adicionar testes de regressão para o transcript de `v0.0.2`.
3. Confirmar modelo vivo (`npm run check:model`) e logs (`npm run check:logs`).
4. Capturar evidências reais e preencher a tabela do `README.md`.
5. Convidar o instrutor e manter a API acessível até a correção.
6. Avaliar o requisito de streaming/WebSocket e o frontend S3/CloudFront se a SCP permitir.
