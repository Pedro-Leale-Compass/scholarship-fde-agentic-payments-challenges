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

# usuário do instrutor criado no Cognito pelo CDK
export TEST_EMAIL=<test-email>
export TEST_PASSWORD='<senha-temporaria>'

# cdk deploy + build e publicação do frontend no Amplify
npm run deploy
```

O `npm run deploy` executa `cdk deploy --require-approval never --outputs-file`
e, em seguida, `scripts/deploy-frontend.sh`, que builda o Next.js, gera o
`config.json` de runtime e publica no Amplify Hosting.

Saídas: `ApiUrl`, `FrontendUrl`, `CognitoUserPoolId`, `CognitoUserPoolClientId`, `AgentRuntimeArn`.

**Nota sobre CloudFront:** esta conta tem uma SCP que nega
`cloudfront:CreateDistribution`, `CreateOriginAccessControl` e
`CreateCloudFrontOriginAccessIdentity`. Por isso o frontend usa **Amplify Hosting**
(HTTPS + CDN) em vez de S3 + CloudFront + OAC. O bucket S3 privado + OAC continua
como desenho documentado, mas não é implantável nesta conta.

## Ambiente de desenvolvimento

Fluxo remoto primeiro: a API, o agente e o banco rodam na AWS; localmente só o frontend.

```bash
# credenciais do perfil (o CDK/SDK não leem o login_session do AWS CLI)
eval "$(scripts/aws-creds.sh)"

# deploy
npm run deploy

# frontend local apontando para a API publicada
NEXT_PUBLIC_API_URL=<ApiUrl do output> npm run dev:frontend
```

Para iterar no prompt do agente sem redeploy, `npm run dev:agent` roda o agente
localmente (porta 3031) com Bedrock real e as tools em fallback em memória.

## Modelo usado

- Amazon Bedrock — Claude Haiku (modelo alvo do desafio)
- Agente Strands rodando no Bedrock AgentCore Runtime
- Enquanto o acesso ao Claude Haiku não é liberado na conta, o agente usa
  `global.amazon.nova-2-lite-v1:0`. Para trocar, basta definir `BEDROCK_MODEL_ID`
  (local) ou ajustar `MODEL_ID` em `infra/lib/agent-stack.ts` (deploy).

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
cd Desafio-1/luiz-henrique/infra

# Destruir a stack (único comando)
cdk destroy --force
```

Confirmar no console AWS que não restou: bucket S3, distribuição CloudFront, runtime do AgentCore, imagens no ECR, tabelas DynamoDB, logs CloudWatch.

## Regras essenciais

- Tudo em `us-east-1`.
- Frontend em Amplify Hosting (HTTPS). S3 privado + CloudFront/OAC não é permitido pela SCP da conta.
- CORS da API aceita apenas o domínio do Amplify.
- Cognito sem auto cadastro (`AllowAdminCreateUserOnly`); usuários entram por convite.
- `usuario_id` vem do `sub` do token, nunca do corpo nem do modelo.
- Valor da compra vem da intenção salva; pagamento e limite usam escritas condicionais (sem duplicidade).
- Manter a aplicação no ar até a correção.
- Criar no Cognito um usuário com o e-mail do instrutor.
