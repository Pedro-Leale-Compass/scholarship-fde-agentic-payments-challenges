# AGENTS.md — Desafio 1 (luiz-henrique)

Instruções para qualquer agente/pessoa que trabalhe neste projeto. O objetivo é evitar
trabalho fora da pasta/branch, afirmações desatualizadas e custo AWS desnecessário.

Baseline atual: tag **`v0.0.3` — “checkout state fixed and validated”** (`947da6f`).
Baseline histórico: `v0.0.2` — “chat works sometimes” (`d854762`).

## 1. Pasta e branch

Trabalhe **somente** em:

```
Desafio-1/luiz-henrique/
```

Branch exclusiva:

```
fellow/luiz-henrique-desafio-1
```

Não faça commit em `main`, `develop`, `master` ou outra branch. Antes de commitar:

1. `git branch --show-current` deve retornar `fellow/luiz-henrique-desafio-1`.
2. `git status --short` deve listar apenas caminhos dentro de `Desafio-1/luiz-henrique/`.
3. Adicione apenas a pasta: `git add Desafio-1/luiz-henrique/`. Nunca `git add .` na raiz.
4. Nunca commite `.env`, `infra/cdk-outputs.json`, `tests/postman-environment.json`,
   credenciais, tokens ou chaves.

## 2. Estado real da stack

- Região `us-east-1`; prefixo `luiz-henrique`.
- Frontend Next.js roda **local** em `http://localhost:3000`. Não há S3 de site,
  CloudFront, OAC, Amplify Hosting, VPC ou NAT Gateway no repositório.
  `infra/dist/lib/frontend-stack.*` é artefato antigo de build e não é usado.
- API Gateway **REST** com `POST /chat` e autorizador JWT Cognito. Não há
  `GET /conversas`, streaming ou WebSocket. O histórico completo é enviado pelo frontend,
  mas ainda não é persistido em `Conversas`.
- Agente Strands no Bedrock AgentCore Runtime; runtime criado por `CustomResource`
  (`infra/lambda/agent-runtime/index.ts`), não por `CfnResource`.
- Tools em 3 Lambdas: `listar_catalogo`, `registrar_intencao`, `realizar_compra`.
- DynamoDB: `Usuarios`, `Conversas`, `Intencoes`, `Catalogo`. `Conversas` guarda o
  `pending_intencao_id` por conversa.
- Modelo: Bedrock Claude Haiku 4.5 via `BEDROCK_MODEL_ID` (runtime v15, confirmado em
  2026-11-17); fallback do código é `global.amazon.nova-2-lite-v1:0` se a variável não
  existir.
- `Usuarios.ultima_intencao_id` é legado problemático; ver §5.

Se um doc antigo contradizer esta seção, o código e os docs canônicos vencem. Corrija o doc
na mesma alteração.

## 3. Fonte de verdade da documentação

Comece por [`docs/README.md`](docs/README.md).

| Documento | Uso |
|---|---|
| `README.md` | visão geral, comandos, dados, IAM e limitações |
| `docs/PLAN-AGENT-REVAMP.md` | plano detalhado da correção do checkout |
| `docs/STACK.md` | arquitetura implementada |
| `docs/MODELO-BEDROCK-TOOLS.md` | modelo, tools, runtime e falhas conhecidas |
| `docs/MODELO-USUARIOS.md` | DynamoDB |
| `docs/DEV-LOCAL-AGENTE.md` | agente local e paridade |
| `docs/OPERATIONS.md` | deploy, modelo, logs, custos, destroy |
| `docs/REQUISITOS-PDF-E-AUDITORIA.md` | requisitos × estado atual |
| `docs/TEST-STRATEGY.md` | suíte futura de 100+ casos e caso de recusa/catálogo |
| `docs/TODO.md` | somente lista de tarefas |
| `docs/archive/` | histórico; **não** usar como estado atual |

Convenções:

- Doc canônico declara data de verificação e referencia código quando afirma comportamento.
- Mudou código que afeta o doc? Atualize o doc no mesmo commit.
- `TODO.md` é só tarefas; não coloque explicações longas nele.
- Não reescreva docs históricos para “parecer atuais”; mova para `archive/` se necessário.
- Não invente URLs, ARNs, IDs ou resultados de testes. Se não foi verificado, diga.

## 4. Comandos

```bash
npm run setup                  # raiz + frontend
npm --prefix infra install     # CDK (primeira vez)
npm --prefix agent install     # agente local (primeira vez)

npm run dev                    # frontend local :3000
npm run dev:agent              # agente local :3031 (Bedrock real)
npm run deploy:api-agent       # deploy backend/agente
npm run diff                   # cdk diff antes do deploy
npm run test:local             # fluxo local do agente (fallback, Haiku)
npm run test:agent             # testes na stack implantada
npm run check:model            # modelo vivo (control plane, read-only)
npm run check:logs             # logs do agente/tools (read-only)
npm run destroy                # destroy + cleanup
```

Credenciais:

```bash
aws sso login --profile desafio-1
eval "$(scripts/aws-creds.sh)"
```

## 5. Foco atual

A reutilização de `intencao_id` do `v0.0.2` foi removida do código:

- o chat não envia mais `Usuarios.ultima_intencao_id`;
- `groundIntencaoIds`, `completePaymentFallback` e os overrides de ID foram removidos;
- `registrar_intencao` só marca registrado com `ok: true`;
- falha visível no lugar de reescrita silenciosa;
- status terminais têm códigos distintos.

Validado com `npm run test:local` e `npm run test:agent` (3/3 em 2026-11-17). Estado por
conversa (`conversa_id`) implementado em `Conversas`, com fallbacks usando apenas dados
verificados. O agente funcionou nos primeiros pedidos reais. Ainda falta:

- `GET /conversas` e histórico de mensagens em `Conversas`;
- API Gateway Stream/WebSocket;
- preço resolvido pelo catálogo;
- suíte ampla de 100+ casos (inclui loop de recusa; ver `docs/TEST-STRATEGY.md`);
- convite do instrutor e capturas de tela/Postman.

Não reintroduza regex/grounding para “corrigir” IDs. Siga o
[`docs/PLAN-AGENT-REVAMP.md`](docs/PLAN-AGENT-REVAMP.md).

## 6. Custos (importante)

- Orçamento: **US$ 20**; aproximadamente **US$ 5** gastos.
- Não crie serviços pagos novos sem necessidade explícita: VPC/NAT, CloudFront, Amplify
  Hosting, jobs agendados, instâncias, provisioned capacity.
- DynamoDB é on-demand; mantenha assim.
- CloudWatch Logs tem free tier, mas evite retenção infinita e logs verbosos.
- Testes com Bedrock custam por token. Prefira o fallback local para iterar prompt; use a
  stack implantada só para validar persistência/códigos.
- `check:model` e `check:logs` não invocam Bedrock; use-os antes de supor o modelo/logs.
- Rode `npm run diff` e revise se aparecer recurso novo antes de `deploy`.

## 7. Modelo e logs

- Confirme o modelo vivo: `npm run check:model`.
- O `.env` com Haiku não garante que o runtime implantado usa Haiku. O CDK lê
  `BEDROCK_MODEL_ID` no synth; deploy sem `.env` usa Nova.
- No modo local, `agent/index.ts` carrega o `.env` da raiz; se `aws-creds.sh` exportou
  credenciais estáticas, o `AWS_PROFILE` do `.env` é ignorado.
- Logs: `npm run check:logs`. Procure `/aws/bedrock-agentcore/*` e
  `/aws/lambda/luiz-henrique-*`.
- Eventos úteis do runtime: `guard: fabricated_turn_removed`,
  `guard: registration_reply_adjusted`, `guard: registration_fallback`,
  `guard: purchase_reply_adjusted`, `guard: payment_fallback_verified`.
- Logs das tools mostram `tool: registrar_intencao`/`realizar_compra` e o `intencao_id`.

## 8. Regras do desafio (resumo)

- Tudo em `us-east-1`; prefixo `luiz-henrique`.
- Cognito sem auto cadastro (`AllowAdminCreateUserOnly`); usuários por convite.
- `usuario_id` vem do `sub` do JWT, nunca do corpo nem do modelo.
- API responde `401` sem token válido.
- CORS restrito à origem do frontend (`http://localhost:3000`).
- IAM de menor privilégio; exceção documentada do ECR.
- Nenhum segredo no Git.
- Modelo: Amazon Bedrock (Claude Haiku) via Strands no AgentCore Runtime.
- Manter a aplicação no ar até a correção e criar o usuário do instrutor.

## 9. Checklist antes de commitar

- [ ] Branch correta (`fellow/luiz-henrique-desafio-1`).
- [ ] `git status` só mostra `Desafio-1/luiz-henrique/`.
- [ ] Nenhum segredo/credencial/ARN privado adicionado.
- [ ] `npx tsc --noEmit` em `agent/` e `infra/` (se alterou TS).
- [ ] Docs afetados atualizados; nada de afirmação não verificada.
- [ ] Se alterou infra: `npm run diff` revisado, sem recurso pago novo.
- [ ] Se alterou agente: teste local e/ou `npm run test:agent` conforme o risco.
- [ ] Mensagem de commit clara e referente ao desafio.

## 10. Limpeza após a correção

Rodar `npm run destroy` e confirmar que não restou runtime, ECR, tabelas, log groups,
roles ou API. Detalhes em `docs/destroy-cleanup.md`.
