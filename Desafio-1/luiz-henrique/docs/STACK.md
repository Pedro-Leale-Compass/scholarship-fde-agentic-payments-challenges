# Stack de tecnologia — Desafio 1 (luiz-henrique)

Decisões tomadas antes de iniciar a implementação.

## 1. IaC: AWS CDK (TypeScript)

- Linguagem: TypeScript.
- CLI: `cdk` (v2).
- Comando único de deploy: `cdk deploy --require-approval never` (pasta `infra/`).
- Comando único de destroy: `cdk destroy --force`.
- Motivo: o time já trabalha com TypeScript; o CDK gera CloudFormation sob o panos
  e permite definir DynamoDB, API Gateway, Lambda, Cognito, S3, CloudFront, ECR e
  AgentCore Runtime em uma só stack, com tipos e testes (`cdk synth`/`cdk diff`).

## 2. Frontend: Next.js (App Router) + Amplify Auth (biblioteca)

- Framework: Next.js (App Router), TypeScript.
- Estilização: Tailwind CSS.
- Geração estática: `next build` + `next export` (output: 'export') → pasta `out/`.
- Autenticação: `aws-amplify` + componente `Authenticator` de `@aws-amplify/ui-react`, apontando para o Cognito User Pool criado pelo IaC (login via e-mail/senha; sem auto-cadastro).
- Hospedagem: local (`http://localhost:3000`) em desenvolvimento; no futuro S3 + CloudFront/OAC (bloqueado por SCP nesta conta). Sem Amplify Hosting.

## 3. Serviços AWS por camada

| Camada | Serviço | Detalhes |
|--------|---------|----------|
| Autenticação | Cognito User Pool | Sem auto-cadastro (`selfSignUpEnabled: false`); usuários entram por convite; login via SDK `aws-amplify`; `usuario_id` vem do `sub` do JWT |
| Frontend | Next.js local + Amplify Auth | Next.js estático (`next export`) rodando localmente na porta 3000; login Cognito via `Authenticator` do `@aws-amplify/ui-react` |
| API | API Gateway REST | Autorizador JWT Cognito; resposta `401` sem token válido |
| Chat | Lambda (Node 20) | Chama o agente Strands no AgentCore Runtime |
| Agente | Bedrock AgentCore Runtime | Modelo Claude Haiku (Strands); imagem de container no ECR |
| Tools | 3 Lambdas (Node 20) | `listar_catalogo`, `registrar_intencao`, `realizar_compra`; IAM de menor privilégio |
| Banco | DynamoDB | Tabelas prefixadas `luiz-henrique`: `usuarios`, `conversas`, `intencoes`; escritas condicionais |

## 4. Regras do desafio mantidas

- Região: `us-east-1`.
- Prefixo de recursos: `luiz-henrique`.
- IAM de menor privilégio; nenhum `*` nem `AdministratorAccess`.
- `usuario_id` vem do `sub` do token JWT, nunca do corpo nem do modelo.
- CORS da API aceita apenas o domínio do frontend configurado (`frontendUrl`: `http://localhost:3000` em desenvolvimento local).
- Nenhum segredo no Git (sem `.env`, chaves de acesso ou tokens commitados).

## 5. Mapeamento com o projeto anterior (Squad 03 MCP)

Veja `docs/MIGRACAO-ANTERIOR.md` para a estrutura, stack e partes reaproveitáveis do
repositório https://github.com/luiztosk/squad-03-desafio-MCP-agentic.
