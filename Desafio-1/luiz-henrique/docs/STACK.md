# Stack implementada — Desafio 1 (luiz-henrique)

Verificado contra o código em **2026-11-17** (baseline `v0.0.2`).

> Este documento descreve o que **existe hoje** no repositório. O PDF pede S3 + CloudFront
> + OAC; essa parte não foi implementada. O frontend roda localmente em
> `http://localhost:3000`. Ver `REQUISITOS-PDF-E-AUDITORIA.md` para o desvio e
> `PLAN-AGENT-REVAMP.md` para o que ainda será corrigido.

## 1. Diagrama atual

```
Frontend Next.js local (http://localhost:3000)
  └─ login Cognito (Amplify Authenticator, sem auto cadastro)
  ├─ POST /chat  Authorization: Bearer <IdToken>
  └─ GET /conversas?conversa_id=...  (histórico)
        │
        ▼
API Gateway REST (prod) + autorizador JWT Cognito
        │
        ▼
Lambda do chat (Node 20, 256 MB, 2 min)
  ├─ valida o sub do token
  ├─ cria/atualiza o item lazy em Usuarios
  ├─ envia pending_intencao_id verificado ao runtime
  └─ InvokeAgentRuntime
        │
        ▼
Bedrock AgentCore Runtime (container arm64 no ECR)
  └─ Strands Agent + BedrockModel
       ├─ listar_catalogo   → Lambda → DynamoDB Catalogo
       ├─ registrar_intencao→ Lambda → DynamoDB Intencoes
       └─ realizar_compra   → Lambda → TransactWriteItems (Intencoes + Usuarios)
```

## 2. Serviços e código

| Camada | Implementação | Onde |
|---|---|---|
| IaC | AWS CDK v2 (TypeScript), uma stack `Desafio1Stack` | `infra/bin/desafio-1.ts`, `infra/lib/desafio-1-stack.ts` |
| Frontend | Next.js App Router + Tailwind + Amplify Auth; roda local | `frontend/` |
| Auth | Cognito User Pool, `selfSignUpEnabled: false`, convite por admin | `infra/lib/api-stack.ts` |
| API | API Gateway REST, rota `POST /chat`, autorizador Cognito | `infra/lib/api-stack.ts` |
| Chat | Lambda Node 20 que chama o AgentCore Runtime | `api/index.ts` |
| Agente | Strands no AgentCore Runtime; imagem Docker arm64 | `agent/`, `infra/lib/agent-stack.ts` |
| Tools | 3 Lambdas Node 20, uma por tool | `tools/`, `infra/lib/tools-stack.ts` |
| Dados | DynamoDB on-demand: `Usuarios`, `Conversas`, `Intencoes`, `Catalogo`, `Conexoes` | `infra/lib/database-stack.ts` |
| WebSocket | API Gateway WebSocket **parcial** (`$connect`/`$disconnect`; `$default` falha) | `infra/lib/api-stack.ts`, `api/websocket/index.ts` |
| Imagem | `DockerImageAsset` no ECR; build feito pelo CDK | `infra/lib/agent-stack.ts` |
| Runtime | `CustomResource` com `CreateAgentRuntime`/`UpdateAgentRuntime`/`DeleteAgentRuntime` | `infra/lambda/agent-runtime/index.ts` |
| Modelo | Bedrock Claude Haiku 4.5 via `BEDROCK_MODEL_ID` (runtime v15, confirmado em 2026-11-17); fallback Nova 2 Lite | `agent/index.ts`, `infra/lib/agent-stack.ts` |

Não existem neste repositório: `FrontendStack`, S3 de site, CloudFront, OAC, VPC, NAT
Gateway, Amplify Hosting ou streaming. `infra/dist/lib/frontend-stack.*` é
artefato antigo de build e não é usado pelo CDK atual.

## 3. Deploy

Pré-requisitos: AWS CLI v2, perfil `desafio-1` com sessão válida, Node 20+.

```bash
cd Desafio-1/luiz-henrique
npm install
eval "$(scripts/aws-creds.sh)"     # exporta credenciais do perfil
npm run deploy:api-agent           # cdk deploy --require-approval never
```

O deploy cria/atualiza banco, tools, agente, API e Cognito. Ele **não** publica frontend.
O frontend local lê `frontend/public/config.json` (versionado; identificadores públicos) ou
`infra/cdk-outputs.json` quando presente.

Comandos:

| Comando | Efeito |
|---|---|
| `npm run synth` | `cdk synth` |
| `npm run diff` | `cdk diff` (usar antes de deploy) |
| `npm run deploy:api-agent` | deploy completo do backend/agente |
| `npm run destroy` | `cdk destroy` + `scripts/destroy-cleanup.sh` |
| `npm run dev:frontend` | frontend local em `http://localhost:3000` |
| `npm run dev:agent` | agente local em `http://localhost:3031` |
| `npm run test:agent` | testes de integração na stack implantada |

## 4. IAM (resumo real)

- **Chat Lambda:** `bedrock-agentcore:InvokeAgentRuntime` no runtime;
  `GetItem/PutItem/UpdateItem/Query` em `Usuarios` e `Conversas` (inclui o GSI). Sem acesso
  a `Intencoes`, transações ou Bedrock.
- **WebSocket Lambda:** `GetItem/PutItem/DeleteItem` em `Conexoes`,
  `lambda:InvokeFunction` na ChatFn e `execute-api:ManageConnections` no WebSocket.
- **`listar_catalogo`:** `dynamodb:GetItem/Scan` em `Catalogo`.
- **`registrar_intencao`:** `dynamodb:PutItem` em `Intencoes`.
- **`realizar_compra`:** `dynamodb:GetItem/UpdateItem/TransactWriteItems` em `Intencoes` e
  `Usuarios`.
- **Runtime:** `lambda:InvokeFunction` nas 3 tools, `bedrock:InvokeModel*`/`Converse*` no
  modelo/perfil, ECR pull, e a managed policy `AWSLambdaBasicExecutionRole` (logs).
- Exceção conhecida: `ecr:GetAuthorizationToken` usa `Resource: "*"` porque a API não tem
  escopo por repositório. Documentada no `README.md`.

## 5. Limitações atuais

- Frontend local; sem URL pública S3/CloudFront.
- API REST com `GET /conversas`; WebSocket **parcial** (`$connect` funciona, `$default`
  retorna `Internal server error`). Sem streaming. Continuação em `WS-NEXT.md`.
- `Conversas` guarda `pending_intencao_id` e `mensagens_json` (histórico completo).
- `Usuarios.ultima_intencao_id` é legado e não é mais lido/escrito.
- O fallback local do agente replica os contratos das Lambdas, mas não substitui um teste
  de integração com DynamoDB real.
