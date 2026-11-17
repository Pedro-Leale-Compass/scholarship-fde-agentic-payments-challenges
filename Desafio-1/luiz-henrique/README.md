# Desafio 1 — Agente de Pagamentos na AWS (luiz-henrique)

Sprint 2 · Trilha Pagamentos Agênticos · Trabalho individual

Branch: `fellow/luiz-henrique-desafio-1` · Região: `us-east-1` · Prefixo: `luiz-henrique`

Baseline documentado: tag **`v0.0.2` — “chat works sometimes”** (`d854762`).

> **Estado atual:** o fluxo de compra tem um defeito conhecido de reutilização de
> `intencao_id` depois de uma falha (`LIMITE_EXCEDIDO`) ou de uma compra paga. A causa e o
> plano de correção estão em [`docs/PLAN-AGENT-REVAMP.md`](docs/PLAN-AGENT-REVAMP.md).
> Não use o fluxo de compras em sequência como evidência confiável até a Fase 3 do plano.

## Estrutura

```
Desafio-1/luiz-henrique/
├── frontend/   # Next.js (App Router) + Amplify Authenticator; roda local
├── api/        # Lambda do chat (API Gateway + JWT Cognito)
├── agent/      # Strands no Bedrock AgentCore Runtime (Bedrock)
├── tools/      # Lambdas: listar_catalogo, registrar_intencao, realizar_compra
├── infra/      # CDK: DynamoDB, tools, agente, API, Cognito, ECR
├── scripts/    # credenciais, convite, limite, dev local, check:model/logs, destroy
├── tests/      # suíte Node + coleção Postman
├── docs/       # documentação canônica + archive/ histórico
└── README.md
```

## Arquitetura implementada

```
Frontend Next.js local (http://localhost:3000 · login Cognito/Amplify)
        │  POST /chat + Authorization: Bearer <IdToken>
        ▼
API Gateway REST (prod) + autorizador JWT Cognito
        ▼
Lambda do chat
  ├─ valida o sub do token
  ├─ garante o item em Usuarios (lazy)
  └─ InvokeAgentRuntime
        ▼
AgentCore Runtime (container arm64 no ECR)
  └─ Strands + BedrockModel
       ├─ listar_catalogo    → Lambda → DynamoDB Catalogo
       ├─ registrar_intencao → Lambda → DynamoDB Intencoes
       └─ realizar_compra    → Lambda → TransactWriteItems (Intencoes + Usuarios)
```

Não há S3/CloudFront/OAC, VPC, NAT Gateway, Amplify Hosting, WebSocket ou streaming neste
repositório. O frontend roda local. Ver [`docs/STACK.md`](docs/STACK.md).

## Início rápido (frontend)

O `frontend/public/config.json` versionado contém URL da API, User Pool ID e Client ID.
São identificadores públicos, não credenciais.

```bash
git clone <este repositório>
cd Desafio-1/luiz-henrique
npm run setup          # raiz + frontend
npm run dev            # http://localhost:3000
```

- Use a porta **3000** (origem liberada no CORS).
- O login é o `Authenticator` do Cognito, sem cadastro (`hideSignUp`).
- Entre com um e-mail convidado via `npm run user:invite -- <email> [limite]`.
- O navegador só fala com o API Gateway; não recebe ARNs, account ID nem credenciais.

Se `infra/cdk-outputs.json` existir, `npm run dev` regenera o `config.json` a partir dos
outputs antes de subir o Next.js.

## Deploy do backend/agente

Pré-requisitos: AWS CLI v2, perfil `desafio-1`, Node 20+.

```bash
cd Desafio-1/luiz-henrique
npm install
npm --prefix infra install
npm --prefix agent install
eval "$(scripts/aws-creds.sh)"
npm run diff                  # revise o que será criado/alterado
npm run deploy:api-agent
```

`npm run deploy:api-agent` executa
`cdk deploy --require-approval never --outputs-file cdk-outputs.json` na pasta `infra/`.
Saídas: `ApiUrl`, `CognitoUserPoolId`, `CognitoUserPoolClientId`, `AgentRuntimeArn`,
`AgentStackAgentRuntimeIdE93B6B16` (ID do runtime), `UsuariosTableName`, `EcrRepositoryUri`.

`infra/cdk-outputs.json` e `.env` são gitignorados. Não faça commit deles.

### Variáveis de ambiente

Copie `.env.example` para `.env` e preencha o necessário. As principais:

- `BEDROCK_MODEL_ID` — o `.env` usa `us.anthropic.claude-haiku-4-5-20251001-v1:0`.
  Sem essa variável no momento do deploy, o CDK usa
  `global.amazon.nova-2-lite-v1:0` silenciosamente.
- `TEST_EMAIL` / `TEST_PASSWORD` — usuário de teste local.

## Comandos

| Comando | Efeito |
|---|---|
| `npm run setup` | instala dependências da raiz e do frontend |
| `npm run dev` | frontend local em `http://localhost:3000` |
| `npm run dev:frontend` | regenera `config.json` a partir de `cdk-outputs.json` e sobe o frontend |
| `npm run dev:agent` | agente local em `http://localhost:3031` (Bedrock real) |
| `npm run deploy:api-agent` | deploy do backend/agente (CDK) |
| `npm run diff` | `cdk diff` |
| `npm run test:local` | sobe o agente local e roda o fluxo de regressão (fallback, Haiku) |
| `npm run test:agent` | testes de integração na stack implantada |
| `npm run check:model` | lê o `BEDROCK_MODEL_ID` do runtime (read-only, sem custo de Bedrock) |
| `npm run check:logs` | lista log groups/streams do agente e das Lambdas (read-only) |
| `npm run user:invite -- <email> [limite]` | cria usuário no Cognito + saldo + convite |
| `npm run user:set-limit -- <email\|sub> <valor>` | ajusta o saldo disponível |
| `npm run user:reset-limit -- <email>` | volta ao saldo padrão (R$ 500) |
| `npm run destroy` | destroy + limpeza de órfãos |

## Agente local (iteração rápida)

O agente local usa o mesmo `agent/index.ts` e o mesmo Bedrock do runtime. Com os ARNs das
tools configurados, chama as Lambdas reais; sem ARNs, usa o fallback em memória que replica
IDs, códigos, status, expiração e saldo.

```bash
eval "$(scripts/aws-creds.sh)"
export BEDROCK_MODEL_ID=us.anthropic.claude-haiku-4-5-20251001-v1:0
npm run dev:agent
```

Detalhes, exemplos de `curl` e paridade local/remota: [`docs/DEV-LOCAL-AGENTE.md`](docs/DEV-LOCAL-AGENTE.md).

## Modelo usado

- Amazon Bedrock — Claude Haiku 4.5 (`us.anthropic.claude-haiku-4-5-20251001-v1:0`).
- Strands Agent no Bedrock AgentCore Runtime.
- **Confirmado no runtime em 2026-11-17:** `luiz_henrique_agent-AD3mRGF7e9`, versão 15,
  `READY`, Haiku 4.5.
- Fallback de código: `global.amazon.nova-2-lite-v1:0` se `BEDROCK_MODEL_ID` não existir.
- Confirme o modelo **vivo** (não só o `.env`) com:

```bash
npm run check:model
```

Esse comando consulta o control plane do AgentCore e não invoca o modelo.

## DynamoDB

Tabelas prefixadas com `luiz-henrique` (on-demand). Detalhes em
[`docs/MODELO-USUARIOS.md`](docs/MODELO-USUARIOS.md).

- `Usuarios` — PK `usuario_id` (`sub`): `email`, `limite_centavos` (saldo),
  `gasto_total_centavos`, `status`, `origem`, timestamps. `ultima_intencao_id` é legado e
  **não é mais lido nem escrito** pelo chat; o plano substitui por estado em `Conversas`.
- `Conversas` — PK `conversa_id`, SK `usuario_id`, GSI `usuario_id-index`. Guarda o
  `pending_intencao_id`/`pending_status` por conversa; o frontend envia `conversa_id`.
- `Intencoes` — PK `intencao_id`: `usuario_id`, `produtos`, `valor`, `valor_centavos`,
  `status`, `expira_em`, `created_at`, `forma_pagamento`, `pago_em`, `motivo_falha`.
- `Catalogo` — PK `id`: `nome`, `preco` (seed do CDK).

Regras de escrita:

- `usuario_id` vem do `sub` do JWT, nunca do corpo nem do modelo.
- Compra: `TransactWriteItems` debita `Usuarios.limite_centavos` (condição
  `limite_centavos >= valor` e `status = ativo`) e marca a intenção como `paga`
  (condição `status = pendente`). Ou tudo acontece, ou nada é debitado.
- Intenção só é paga se existir, for do próprio usuário, estiver `pendente` e não expirada
  (15 minutos).

## IAM (resumo)

- Sem `AdministratorAccess`; nenhum `*` exceto `ecr:GetAuthorizationToken` (a API não
  aceita escopo por repositório).
- Chat Lambda: `bedrock-agentcore:InvokeAgentRuntime` + `GetItem`/`PutItem`/`UpdateItem`
  em `Usuarios`.
- `listar_catalogo`: `GetItem`/`Scan` em `Catalogo`.
- `registrar_intencao`: `PutItem` em `Intencoes`.
- `realizar_compra`: `GetItem`/`UpdateItem`/`TransactWriteItems` em `Intencoes` e
  `Usuarios`.
- AgentCore Runtime: Bedrock + invocação das 3 tools + ECR pull + logs
  (`AWSLambdaBasicExecutionRole`), sem acesso direto às tabelas.
- Nenhum segredo no Git.

## Limitações e pendências

- Frontend local; sem URL pública S3/CloudFront/OAC (SCP da conta).
- API REST sem streaming/WebSocket.
- `Conversas` guarda o estado de checkout; o histórico completo de mensagens ainda não é
  persistido.
- A reutilização de `intencao_id` foi removida e validada localmente (`npm run test:local`)
  e na stack implantada (`npm run test:agent`, 2026-11-17).
- `registrar_intencao` ainda aceita preço/produto vindos do modelo; o plano move para o
  catálogo.
- Capturas de tela/Postman ainda não foram anexadas; os resultados da suíte estão na tabela
  de evidências.

## Evidências

| Caso | Resultado esperado | Evidência |
|---|---|---|
| Login com usuário válido | JWT obtido; acesso liberado | `npm run test:agent` cria/loga usuário (2026-11-17) |
| Requisição sem token | `401` | teste de integração passou (2026-11-17) |
| Compra com cartão | Intenção paga e saldo debitado | teste de integração passou (2026-11-17) |
| Compra com Pix | Intenção paga e saldo debitado | teste de integração passou (2026-11-17) |
| Limite excedido | Compra rejeitada com `LIMITE_EXCEDIDO` | teste de integração passou (2026-11-17) |
| `intencao_id` inválido | `INTENCAO_INVALIDA` | teste de ferramenta passou (2026-11-17) |
| Novo produto após cancelamento | Novo ID, sem reutilizar o cancelado | teste de regressão passou; ex.: `INT-B7E0ED4D` cancelada → `INT-F7F74EB2` paga |
| Convite por e-mail | Usuário no Cognito + item em `Usuarios` | pendente |
| Ajuste de saldo | `user:set-limit` altera `limite_centavos` | pendente |

## Custos

- Orçamento atual: **US$ 20**, aproximadamente **US$ 5** gastos.
- Serviços já existentes: DynamoDB on-demand, Lambda, API Gateway, Cognito, ECR,
  AgentCore Runtime, CloudWatch Logs.
- Não crie VPC/NAT, CloudFront, Amplify Hosting, jobs agendados ou outros serviços pagos
  sem necessidade.
- Para iterar prompt, use o fallback local e evite chamadas repetidas ao Bedrock.
- `check:model` e `check:logs` são somente leitura.

## Remoção

```bash
eval "$(scripts/aws-creds.sh)"
npm run destroy
```

Confirme no console/CLI que não restou runtime do AgentCore, imagens no ECR, tabelas
DynamoDB, log groups, roles IAM ou REST API. Detalhes:
[`docs/destroy-cleanup.md`](docs/destroy-cleanup.md).

## Documentação

Comece por [`docs/README.md`](docs/README.md). Docs históricos estão em
[`docs/archive/`](docs/archive/README.md) e não representam o estado atual.

## Regras essenciais

- Tudo em `us-east-1`; prefixo `luiz-henrique`.
- Cognito sem auto cadastro; usuários entram por convite.
- `usuario_id` vem do `sub` do token, nunca do corpo nem do modelo.
- Valor da compra vem da intenção salva; pagamento e limite usam escritas condicionais.
- Nenhum segredo no Git.
- Manter a aplicação no ar até a correção e criar o usuário do instrutor no Cognito.
