# Desafio 1 — Agente de Pagamentos na AWS (luiz-henrique)

Sprint 2 · Trilha Pagamentos Agênticos · Trabalho individual

Branch: `fellow/luiz-henrique-desafio-1`

Região: `us-east-1` · Prefixo de recursos: `luiz-henrique`

Repo anterior (referência): https://github.com/luiztosk/squad-03-desafio-MCP-agentic

## Estrutura

```
Desafio-1/luiz-henrique/
├── frontend/   # Chatbot estático (login Cognito + compras simuladas)
├── api/        # API Gateway + Lambda do chat (autorizador JWT Cognito)
├── agent/      # Agente Strands no Bedrock AgentCore Runtime (Claude Haiku)
├── tools/      # Lambdas das tools: listar_catalogo, registrar_intencao, realizar_compra
├── infra/      # IaC (CDK: backend, agente, API, Cognito, DynamoDB, AgentCore)
├── docs/       # TODO.md, STACK.md, MIGRACAO-ANTERIOR.md
└── README.md   # este arquivo
```

## Diagrama implementado

```
Frontend local (Next.js em http://localhost:3000 · login Cognito/Amplify)
        │  HTTPS + Authorization: Bearer <JWT>
        ▼
API Gateway (autorizador JWT Cognito · REST)
        ▼
Lambda do chat ───► Agente Strands no AgentCore Runtime (Bedrock · Claude Haiku)
        │                    ▼
        │             Lambdas das tools ───► DynamoDB (usuários, intenções; conversas na próxima etapa)
        └── registra o usuário (sub + saldo) em Usuarios
```

## Início rápido (clone + npm run dev)

O frontend local já vem com `frontend/public/config.json` versionado: URL do API Gateway,
User Pool ID e Client ID. São **identificadores públicos** (não são credenciais) e permitem
rodar sem AWS CLI, CDK ou `cdk-outputs.json`.

```bash
git clone <este repositório>
cd Desafio-1/luiz-henrique
npm run setup   # instala dependências da raiz e do frontend
npm run dev     # sobe http://localhost:3000
```

- Use a porta **3000** (é a origem liberada no CORS do API Gateway).
- O login é a tela do Cognito (Amplify `Authenticator`, sem cadastro). Entre com o e-mail
  convidado; a senha temporária vai no convite enviado pelo mantenedor via
  `npm run user:invite -- <email> [limite]`.
- Não é necessário clonar o CDK nem ter credenciais AWS no seu ambiente.
- O que **não** vai para o frontend: ARN do AgentCore Runtime, modelo Bedrock, ARNs das
  tools, account ID e credenciais. Tudo isso fica no backend; o navegador só fala com o
  API Gateway, que exige JWT do Cognito.

## Passo a passo de deploy

Pré-requisitos: AWS CLI v2, perfil `desafio-1` configurado e sessão iniciada com `aws sso login`.

```bash
# Na raiz de Desafio-1/luiz-henrique
npm install                      # dependências do CDK (uma vez)

# credenciais do perfil (o CDK/SDK não leem o login_session do AWS CLI)
eval "$(scripts/aws-creds.sh)"

# variáveis de ambiente (TEST_EMAIL, TEST_PASSWORD, etc.) são lidas do .env
# (gitignorado; copie de .env.example e preencha)

# Deploy apenas da API + agente (frontend roda localmente na porta 3000)
npm run deploy:api-agent
```

`npm run deploy` executa `cdk deploy --require-approval never --outputs-file cdk-outputs.json`.

Saídas: `ApiUrl`, `CognitoUserPoolId`, `CognitoUserPoolClientId`, `AgentRuntimeArn`.
Esses valores ficam apenas no `.env` local (gitignorado) e em `infra/cdk-outputs.json`;
não são versionados. A documentação e a coleção Postman usam as variáveis do `.env`.

**Comandos disponíveis:**
- `npm run deploy:api-agent` — API Gateway + Lambda chat + AgentCore Runtime (CORS permite `http://localhost:3000`)
- `npm run deploy` — mesmo que `deploy:api-agent`
- `npm run dev` — atalho para `npm run dev:frontend` (frontend local em `http://localhost:3000`)
- `npm test` — suíte automatizada (`tests/agent.test.mjs`): 401 sem token, contrato de `realizar_compra` e fluxo do agente com estado real no DynamoDB
- `npm run dev:frontend` — gera `frontend/public/config.json` a partir de `infra/cdk-outputs.json` e roda `next dev` em `http://localhost:3000` (usa `Authenticator` do `@aws-amplify/ui-react` apontando para o User Pool do CDK)
- `npm run dev:agent` — roda o agente localmente (porta 3031) com Bedrock real
- `npm run dev:create-test-user` — cria/atualiza o usuário de teste no Cognito User Pool (lê TEST_EMAIL/TEST_PASSWORD do `.env`)

## Convite de usuários e limite de gasto

Cadastro somente por convite (`AllowAdminCreateUserOnly`). O Cognito envia o e-mail de
convite com senha temporária; no primeiro acesso o usuário define a nova senha.

```bash
# cria no Cognito + registra o saldo em Usuarios + envia o convite por e-mail
npm run user:invite -- instrutor@example.com 500

# define um saldo arbitrário (em reais)
npm run user:set-limit -- instrutor@example.com 750

# volta ao saldo padrão (R$ 500)
npm run user:reset-limit -- instrutor@example.com
```

- O convite pelo console do Cognito também funciona: o template de convite está no CDK
  (`userInvitation`) e a Lambda do chat cria o registro em `Usuarios` no primeiro acesso
  (saldo padrão de R$ 500, `origem=lazy`).
- O saldo é consumido a cada compra, numa transação atômica com o pagamento da intenção.
- Nenhuma senha ou token é gravado no DynamoDB.

## Ambiente de desenvolvimento

Fluxo remoto primeiro: a API, o agente e o banco rodam na AWS; localmente só o frontend.

```bash
# credenciais do perfil (o CDK/SDK não leem o login_session do AWS CLI)
eval "$(scripts/aws-creds.sh)"

# deploy da API + agente
npm run deploy:api-agent

# frontend local apontando para a API publicada (usa infra/cdk-outputs.json)
npm run dev:frontend

# criar/atualizar usuário de teste no Cognito (lê TEST_EMAIL/TEST_PASSWORD do .env)
npm run dev:create-test-user
```

Para iterar no prompt do agente sem redeploy, `npm run dev:agent` roda o agente
localmente (porta 3031) com Bedrock real e as tools em fallback em memória.

## Modelo usado

- Amazon Bedrock — Claude Haiku 4.5 (`us.anthropic.claude-haiku-4-5-20251001-v1:0`)
- Agente Strands rodando no Bedrock AgentCore Runtime
- Fallback: se o acesso ao Claude Haiku não estiver liberado na conta, defina
  `BEDROCK_MODEL_ID=global.amazon.nova-2-lite-v1:0` no `.env` e faça
  `npm run deploy:api-agent` (o modelo é lido do .env no deploy da infra e no
  `dev:agent` local; sempre usa `override: true` para não manter valor antigo do shell).

## Testar o agente no console da AWS

O contrato do AgentCore Runtime exige `prompt` **e** `usuario_id` no corpo. O console
não preenche `usuario_id` sozinho: se ele faltar, o runtime responde `400` (validação
do schema) e o console mostra apenas um erro genérico.

```json
{
  "prompt": "liste o catálogo de produtos",
  "usuario_id": "console-test-user"
}
```

- Console: Bedrock AgentCore → Runtimes → `luiz_henrique_agent` → endpoint `DEFAULT`
  → Test/Invoke → colar o JSON acima.
- Em produção (API `/chat`) o `usuario_id` não vem do cliente: a Lambda do chat o
  extrai do `sub` do token Cognito e monta esse payload internamente. Sem token, a API
  responde `401` antes de chamar o runtime.
- Detalhes, comandos de CLI e roteiro de teste: `docs/deploy-findings.md`.

## Modelagem do DynamoDB

Tabelas (prefixadas com `luiz-henrique`). Detalhes em `docs/MODELO-USUARIOS.md`.

- `Usuarios` — PK `usuario_id` (= `sub` do Cognito):
  `email`, `nome` (opcional), `limite_centavos` (saldo disponível, inteiro),
  `gasto_total_centavos`, `status` (`ativo`/`bloqueado`), `origem`
  (`convite`/`console`/`lazy`), `criado_em`, `atualizado_em`, `convite_enviado_em`.
- `Conversas` — PK `conversa_id`, SK `usuario_id`, GSI `usuario_id-index`
  (histórico por usuário; persistência na próxima etapa).
- `Intencoes` — PK `intencao_id`: `usuario_id`, `produtos`, `valor`, `valor_centavos`,
  `status`, `expira_em`, `created_at`, `forma_pagamento`, `pago_em`;
  GSI `usuario_id-index`.
- `Catalogo` — PK `id`: `nome`, `preco` (seed do CDK).

Regras de escrita:

- `usuario_id` vem do `sub` do token JWT, nunca do corpo nem do modelo.
- Compra: `TransactWriteItems` debita `Usuarios.limite_centavos` (condição
  `limite_centavos >= valor` e `status = ativo`) e marca a intenção como `paga`
  (condição `status = pendente`). Ou tudo acontece, ou nada é debitado.
- Intenção aceita só se existir, for do próprio usuário, estiver `pendente` e não expirada
  (15 minutos).

## Resumo do IAM

- IAM de menor privilégio; nenhum curinga `*`; nenhum `AdministratorAccess`.
- Lambda do chat: `bedrock-agentcore:InvokeAgentRuntime` no runtime + `GetItem`/`PutItem`/
  `UpdateItem` apenas em `Usuarios` (registro do usuário no primeiro acesso).
- `listar_catalogo`: `GetItem`/`Scan` só em `Catalogo`.
- `registrar_intencao`: `PutItem` só em `Intencoes`.
- `realizar_compra`: `GetItem`/`TransactWriteItems` em `Intencoes` e `Usuarios`.
- API Gateway: autorizador JWT Cognito.
- AgentCore Runtime: Bedrock + invocação das 3 Lambdas de tool + logs (sem acesso direto às
  tabelas).
- Nenhum segredo no Git.

## Evidências

| Caso | Resultado esperado | Evidência |
|------|-------------------|-----------|
| Login com usuário válido | JWT obtido; acesso liberado | pendente |
| Requisição sem token | `401` | pendente |
| Compra com cartão de crédito | Sucesso; intenção registrada e paga | pendente |
| Compra com Pix | Sucesso; intenção registrada e paga | pendente |
| Limite excedido | Compra rejeitada | pendente |
| `intencao_id` inválido | Erro; intenção não encontrada | pendente |
| Convite por e-mail | Usuário criado no Cognito + item em `Usuarios` | pendente |
| Ajuste de saldo por CLI | `user:set-limit` altera `limite_centavos` | pendente |

Adicionar screenshots/logs de cada evidência nesta seção.

## Instruções de remoção (após a correção)

```bash
# Na raiz de Desafio-1/luiz-henrique
eval "$(scripts/aws-creds.sh)"

# Destruir a stack CDK (API + agente + Cognito + DynamoDB + AgentCore + ECR)
npm run destroy
```

Confirmar no console AWS que não restou: runtime do AgentCore, imagens no ECR, tabelas DynamoDB, logs CloudWatch.

## Regras essenciais

- Tudo em `us-east-1`.
- Frontend roda localmente (`http://localhost:3000`); no futuro pode ser S3 + CloudFront/OAC (bloqueado por SCP nesta conta).
- CORS da API aceita apenas o domínio do frontend configurado (`http://localhost:3000` em desenvolvimento local).
- Cognito sem auto cadastro (`AllowAdminCreateUserOnly`); usuários entram por convite.
- `usuario_id` vem do `sub` do token, nunca do corpo nem do modelo.
- Valor da compra vem da intenção salva; pagamento e limite usam escritas condicionais (sem duplicidade).
- Manter a aplicação no ar até a correção.
- Criar no Cognito um usuário com o e-mail do instrutor.
