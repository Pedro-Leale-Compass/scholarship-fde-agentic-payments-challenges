# Desafio 1 — Agente de Pagamentos na AWS (luiz-henrique)

Sprint 2 · Trilha Pagamentos Agênticos · Trabalho individual

Branch: `fellow/luiz-henrique-desafio-1`

Região: `us-east-1` · Prefixo de recursos: `luiz-henrique`

## Estrutura

```
Desafio-1/luiz-henrique/
├── frontend/   # Chatbot estático (login Cognito + compras simuladas)
├── api/        # API Gateway + Lambda do chat (autorizador JWT Cognito)
├── agent/      # Agente Strands no Bedrock AgentCore Runtime (Claude Haiku)
├── tools/      # Lambdas das tools: listar_catalogo, registrar_intencao, realizar_compra
├── infra/      # IaC (CDK: backend, agente, frontend no Amplify Hosting)
├── docs/       # TODO.md, STACK.md, MIGRACAO-ANTERIOR.md
└── README.md   # este arquivo
```

## Diagrama implementado

```
Amplify Hosting (frontend estático + login Cognito)
        │  HTTPS + Authorization: Bearer <JWT>
        ▼
API Gateway (autorizador JWT Cognito · streaming/WebSocket)
        ▼
Lambda do chat ───► Agente Strands no AgentCore Runtime (Bedrock · Claude Haiku)
                          ▼
                   Lambdas das tools ───► DynamoDB (usuários, conversas, intenções/transações)
```

## Passo a passo de deploy

Pré-requisitos: AWS CLI v2, perfil `desafio-1` configurado e sessão iniciada (`aws login` / `aws sso login`).

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

**Comandos disponíveis:**
- `npm run deploy:api-agent` — API Gateway + Lambda chat + AgentCore Runtime (CORS permite `http://localhost:3000`)
- `npm run deploy` — mesmo que `deploy:api-agent`
- `npm run dev:frontend` — gera `frontend/public/config.json` a partir de `infra/cdk-outputs.json` e roda `next dev` em `http://localhost:3000` (usa `Authenticator` do `@aws-amplify/ui-react` apontando para o User Pool do CDK)
- `npm run dev:agent` — roda o agente localmente (porta 3031) com Bedrock real
- `npm run dev:create-test-user` — cria/atualiza o usuário de teste no Cognito User Pool (lê TEST_EMAIL/TEST_PASSWORD do `.env`)

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

- Amazon Bedrock — Claude Haiku (modelo alvo do desafio)
- Agente Strands rodando no Bedrock AgentCore Runtime
- Enquanto o acesso ao Claude Haiku não é liberado na conta, o agente usa
  `global.amazon.nova-2-lite-v1:0`. Para trocar, defina `BEDROCK_MODEL_ID` no
  `.env` (lido tanto no deploy da infra quanto no `dev:agent` local).

## Modelagem do DynamoDB

Tabelas (prefixadas com `luiz-henrique`):

- `Usuarios`: `usuario_id` (PK, = sub do Cognito), dados do cadastro por convite.
- `Conversas`: `conversa_id` (PK), `usuario_id` (SK/GSI), histórico de mensagens.
- `Intencoes`: `intencao_id` (PK), `usuario_id`, produtos, valor, status, carimbo de tempo.

Escritas condicionais para pagamento e limite (sem duplicidade). `usuario_id` vem do `sub` do token JWT, nunca do corpo nem do modelo.

## Resumo do IAM

- IAM de menor privilégio; nenhum curinga `*`; nenhum `AdministratorAccess`.
- Lambda do chat: invocação do AgentCore Runtime + leitura DynamoDB.
- Lambdas das tools: escrita condicional nas tabelas DynamoDB correspondentes.
- API Gateway: autorizador JWT Cognito.
- AgentCore Runtime: execução do agente Strands com Bedrock.
- Amplify Hosting (substitui S3 + CloudFront, bloqueado por SCP nesta conta).
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

Adicionar screenshots/logs de cada evidência nesta seção.

## Instruções de remoção (após a correção)

```bash
# Na raiz de Desafio-1/luiz-henrique
eval "$(scripts/aws-creds.sh)"

# 1. (se aplicável) Remover app Amplify órfão — não está mais no CDK
aws amplify list-apps --region us-east-1
# Se houver um app, deletá-lo manualmente:
aws amplify delete-app --app-id <APP_ID> --region us-east-1

# 2. Destruir a stack CDK (API + agente + Cognito + DynamoDB + AgentCore + ECR)
npm run destroy
```

Confirmar no console AWS que não restou: app Amplify, runtime do AgentCore, imagens no ECR, tabelas DynamoDB, logs CloudWatch.

## Regras essenciais

- Tudo em `us-east-1`.
- Frontend roda localmente (`http://localhost:3000`); no futuro pode ser S3 + CloudFront/OAC (bloqueado por SCP nesta conta).
- CORS da API aceita apenas o domínio do frontend configurado (`http://localhost:3000` em desenvolvimento local).
- Cognito sem auto cadastro (`AllowAdminCreateUserOnly`); usuários entram por convite.
- `usuario_id` vem do `sub` do token, nunca do corpo nem do modelo.
- Valor da compra vem da intenção salva; pagamento e limite usam escritas condicionais (sem duplicidade).
- Manter a aplicação no ar até a correção.
- Criar no Cognito um usuário com o e-mail do instrutor.
