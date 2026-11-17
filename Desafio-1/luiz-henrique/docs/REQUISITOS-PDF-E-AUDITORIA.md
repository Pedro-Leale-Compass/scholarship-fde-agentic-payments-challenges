# Requisitos do PDF × estado atual

Verificado em **2026-11-17** contra o código e os outputs da stack. Baseline `v0.0.5`.

Legenda: ✅ atende · 🟡 parcial · ❌ não atende · ⏸ adiado por decisão explícita.

## 1. Stack e arquitetura

| Requisito | Estado | Evidência/observação |
|---|---|---|
| Migrar o chatbot da Fase 1 para AWS | ✅ | `api/`, `agent/`, `tools/`, `infra/` |
| Manter regras de negócio (catálogo, intenção, cartão/Pix, limite) | ✅ | fluxo corrigido e validado (ver §4) |
| Tudo em `us-east-1`; prefixo `luiz-henrique` | ✅ | `infra/bin/desafio-1.ts`, `database-stack.ts` |
| Comunicação frontend ↔ backend via API Gateway | ✅ | `POST /chat` com JWT Cognito |
| `GET /conversas` para carregar histórico | ✅ | rota GET com JWT; histórico em `Conversas.mensagens_json`; testado |
| Frontend S3 privado + CloudFront + OAC com URL pública | ❌/⏸ | frontend roda local; não existe `FrontendStack` |
| `config.json` gerado pelo IaC no deploy | 🟡 | `frontend/public/config.json` é versionado; `scripts/dev-frontend-local.sh` regenera a partir de `cdk-outputs.json` quando presente |
| Cognito + `Authenticator`, `hideSignUp`, sem auto cadastro | ✅ | `frontend/app/page.tsx:60`; `infra/lib/api-stack.ts` |
| API Gateway + autorizador JWT | ✅ | `infra/lib/api-stack.ts` |
| API “Stream ou WebSocket” | 🟡 | WebSocket parcial: `$connect`/`$disconnect` OK; `$default` falha; REST é o caminho estável |
| Histórico completo enviado ao agente a cada turno | ✅ | a API envia `messages` completo; validado em 2026-11-17 |
| Preço/produto resolvidos no catálogo | ✅ | `registrar_intencao` recebe `produto_id`/quantidade e usa `preco_centavos` |
| Strands no AgentCore Runtime + Bedrock | ✅ | `agent/index.ts`; runtime via `CustomResource`; Haiku 4.5 no runtime v15 (2026-11-17) |
| 3 tools em Lambda | ✅ | `tools/` + `infra/lib/tools-stack.ts` |
| DynamoDB: usuários+limite, conversas, intenções | ✅ | `Usuarios`/`Intencoes`/`Catalogo`; `Conversas` guarda estado e `mensagens_json`; `Conexoes` para WebSocket |
| IaC com um comando para o ambiente completo, incluindo frontend | ❌/⏸ | `npm run deploy:api-agent` cobre backend/agente; frontend fica local (decisão registrada) |

## 2. Segurança e regras de compra

| Requisito | Estado | Observação |
|---|---|---|
| Sem token → `401` no API Gateway | ✅ | authorizer Cognito; teste em `tests/agent.test.mjs` |
| `usuario_id` vem do `sub` do token, nunca do corpo/modelo | ✅/🟡 | o chat extrai do token e envia ao runtime; as tools confiam no payload do runtime (IAM restrito) |
| Valor da compra vem da intenção salva | ✅ | `realizar_compra` lê `Intencoes.valor_centavos` |
| Só paga intenção do próprio usuário, `pendente`, não expirada | ✅ | `tools/realizar_compra/index.ts` |
| Pagamento/limite sem duplicidade (condicional/transação) | ✅ | `TransactWriteItems` com `status = pendente` e `limite_centavos >= valor` |
| IAM de menor privilégio, sem `*`/`AdministratorAccess` | ✅/🟡 | chat Lambda sem acesso a `Intencoes`/transações/Bedrock (validado); tools acessam só suas tabelas; exceção documentada `ecr:GetAuthorizationToken` com `*` |
| Nenhum segredo no Git | ✅ | `.env`/`cdk-outputs.json`/`postman-environment.json` ignorados |
| CORS restrito à origem do frontend | ✅ | `FRONTEND_URL`/`frontendUrl` = `http://localhost:3000` |

## 3. Entrega e operação

| Requisito | Estado | Observação |
|---|---|---|
| README com diagrama, deploy, modelo, DynamoDB, IAM e remoção | ✅ | reestruturado nas seções 1–7 do PDF; capturas em `docs/apresentacao/` |
| Evidências: login, 401, cartão, Pix, limite, ID inválido | 🟡 | login/catálogo/cartão/Pix/limite em `docs/apresentacao/`; 401/ID inválido cobertos por teste, faltam prints |
| Aplicação no ar até a correção | 🟡 | API/agente no ar; frontend local; falta convidar o instrutor |
| Usuário do instrutor no Cognito | ❌ | usar `npm run user:invite -- <email> [limite]` |
| Alerta de orçamento | 🟡 | orçamento de US$ 20 mencionado (≈US$ 5 gastos); não há registro neste repo de alarme criado. Criar AWS Budget é gratuito (primeiros 2); se já existir, registre o ID/limite aqui |
| Destroy + limpeza | ✅ | `npm run destroy` + `scripts/destroy-cleanup.sh` + `destroy-cleanup.md` |
| Extras (MCP Gateway, Memory, Guardrails, traces) | ⏸ | não previstos |

## 4. Defeito corrigido e validado na stack

O transcript de `v0.0.2` reutilizava `INT-E36C946B` ao comprar outro produto depois de um
`LIMITE_EXCEDIDO`. Correções aplicadas e validadas localmente com `npm run test:local`:

- o chat não envia mais `Usuarios.ultima_intencao_id`;
- `groundIntencaoIds`, `completePaymentFallback` e os overrides de ID foram removidos;
- `registrar_intencao` só marca registrado com `ok: true`;
- guarda de registro devolve falha visível;
- o histórico não esconde mais a mensagem de falha;
- `cancelada`/`expirada`/`paga` têm códigos distintos.

O estado por conversa (`conversa_id`), os fallbacks determinísticos e os códigos distintos
foram implementados e validados na stack em 2026-11-17 (`npm run test:agent`, 3/3). O plano
detalhado está em [`PLAN-AGENT-REVAMP.md`](PLAN-AGENT-REVAMP.md).

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
cd Desafio-1/luiz-henrique/frontend
npm install
npm run dev
```

## 6. Convenção de pasta

O PDF usa `fellows/<seu-nome>/`; o repositório usa `Desafio-1/<seu-nome>/`. A entrega segue
a convenção do repositório. A divergência fica registrada aqui e no `README.md`; não é
corrigida localmente.

## 7. Pendências priorizadas

1. [x] Implementar o núcleo do `PLAN-AGENT-REVAMP.md`: estado por conversa, sem
   grounding/overrides, códigos corretos e fallbacks verificados (2026-11-17).
2. [x] Adicionar teste de regressão do transcript de `v0.0.2` e validar na stack (3/3).
3. [x] Confirmar modelo vivo e logs (`npm run check:model` / `check:logs`): v15, Haiku.
4. [x] Preencher a tabela de evidências do `README.md` com o resultado dos testes; ainda
   faltam convite por e-mail e ajuste de saldo.
5. [ ] Convidar o instrutor e manter a API acessível.
6. [ ] Avaliar streaming/WebSocket e frontend S3/CloudFront se a SCP permitir.
7. [x] Resolver preço pelo catálogo e persistir histórico em `Conversas`.
8. [ ] Fechar o WebSocket (`$default`) — ver `WS-NEXT.md`.
