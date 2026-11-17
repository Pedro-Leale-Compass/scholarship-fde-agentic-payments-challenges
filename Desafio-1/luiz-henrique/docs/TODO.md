# TODO — Desafio 1: Agente de Pagamentos na AWS

Sprint 2 · Trilha Pagamentos Agênticos · Trabalho individual · Branch `fellow/luiz-henrique-desafio-1`

Pasta de trabalho: `Desafio-1/luiz-henrique/` com `frontend/ api/ agent/ tools/ infra/ README.md`.

Região: `us-east-1`. Prefixo dos recursos: `luiz-henrique`.

## 0. Preparação (pré-requisitos)

- [x] Aceitar convite do IAM Identity Center (usuário + senha + MFA). — login_session presente em ~/.aws/config (perfil `desafio-1`)
- [x] Instalar AWS CLI v2 (>= 2.22.0). — aws-cli/2.39.5
- [x] Configurar perfil SSO: `aws configure sso` (profile `desafio-1`, região `us-east-1`). — presente em ~/.aws/config
- [x] `export AWS_PROFILE=desafio-1` em cada terminal de deploy. — perfil configurado; exportar por terminal
- [x] `aws sso login` e `aws sts get-caller-identity` para confirmar a conta. — login_session presente
- [x] Criar branch `fellow/luiz-henrique-desafio-1` (já criada) e trabalhar somente em `Desafio-1/luiz-henrique/`.
- [x] Não commitar segredos nem chaves de acesso; nenhum `*` nem `AdministratorAccess` no IAM. — nada commitado ainda

## 1. Modelo de dados (DynamoDB)

- [x] Definir modelagem do DynamoDB: usuários, conversas, intenções/transações.
- [x] Escrever o diagrama de modelagem no `docs/TODO.md` ou `README.md`.
- [x] Tabelas: `Usuarios`, `Conversas`, `Intencoes`, `Catalogo` (definidas no CDK; criadas no deploy).
- [x] Chaves de partição e sort definidas; índices secundários se necessário.
- [x] Escrita condicional para evitar duplicidade de pagamento/limite.

## 2. Ferramentas do agente (tools/)

- [x] `listar_catalogo` — retorna catálogo de produtos disponíveis.
- [x] `registrar_intencao` — salva intenção de compra no DynamoDB (condicional).
- [x] `realizar_compra` — efetua pagamento com cartão ou Pix; valida limite e intenção.
- [x] Cada tool em sua própria Lambda com IAM de menor privilégio.
- [x] Tratamento de erros: `intencao_id` inválido, limite excedido, pagamento rejeitado.

## 3. Agente Strands (agent/)

- [x] Implementar agente Strands com as 3 tools acima (código em agent/index.ts)
- [x] Modelo: Amazon Bedrock (Claude Haiku — alvo) via AgentCore Runtime (CDK: CfnAgentRuntime)
- [x] Liberar acesso ao Claude Haiku na conta Bedrock. — ativo: `global.anthropic.claude-haiku-4-5-20251001-v1:0` (runtime v5, verificado em 2026-11-17); fallback Nova 2 Lite mantido no CDK.
- [x] Regras de negócio da Fase 1 inalteradas
- [x] Container image no ECR (repositório criado via CDK; Dockerfile em agent/)
- [x] IAM role com permissões para Bedrock Converse + invoke das 3 tool Lambdas
- [x] Deploy do agente no Bedrock AgentCore Runtime (runtime READY)
- [x] Build e push da imagem arm64 no ECR feito pelo CDK (DockerImageAsset)

**Fluxo de desenvolvimento (remoto primeiro):**

- `eval "$(scripts/aws-creds.sh)"` exporta as credenciais do perfil `desafio-1`
- `npm run deploy` → um único `cdk deploy` cria banco, tools, agente, API e frontend
- Frontend local: `NEXT_PUBLIC_API_URL=<ApiUrl> npm run dev:frontend`
- `npm run dev:agent` roda só o agente (3031) com Bedrock real para iterar no prompt

**Remoto (AWS):**
- `npm run deploy` (CDK builda e publica a imagem do agente no ECR antes de criar o runtime)
- API Lambda chama `InvokeAgentRuntime` no ARN do runtime
- Custos: ECR storage + AgentCore Runtime compute

**Nota:** não há L2 CDK construct para `AWS::BedrockAgentCore::AgentRuntime`, então usa-se `cdk.CfnResource` diretamente.

## 4. API (api/)

- [x] API Gateway (REST) com autorizador JWT Cognito.
- [x] Lambda do chat que chama o AgentCore Runtime via InvokeAgentRuntime (bedrock-agentcore SDK).
- [x] `usuario_id` vem do `sub` do token Cognito, nunca do corpo nem do modelo.
- [x] Resposta `401` sem token válido.
- [x] CORS aceita apenas o domínio do frontend (Amplify).

**Registro de usuários:** Cognito User Pool com `AllowAdminCreateUserOnly` (sem auto cadastro). Usuários são criados por admin via `admin-create-user` após o deploy.

## 5. Frontend (frontend/)

- [x] Login Cognito real (Amplify Auth) usando configuração do runtime.
- [x] `frontend/lib/mock-auth.ts` removido.
- [x] API URL lida de `config.json` publicado no deploy (sem rebuild por ambiente).
- [x] Build estático (`next build`, `output: 'export'`) gerando `frontend/out`.
- [ ] Render markdown nas respostas do agente (apenas texto bruto atualmente).
- [ ] Mostrar nome/email do usuário após "Bem-vindo" (mostrando userId atualmente).
- [ ] Em "Bem-vindo, <valor>", exibir o username/email do usuário Cognito em vez do UUID (`sub`).
- [ ] Corrigir o balão de mensagem do usuário: "Você" está colado ao texto; adicionar espaço entre o rótulo e a mensagem.
- [ ] Rolar a lista de mensagens automaticamente até o fim ao receber/enviar mensagens.
- [ ] Chat box ocupar quase toda a altura vertical (atualmente fixo em 400px).
- [ ] Catálogo menor, alinhado com repo anterior (https://github.com/luiztosk/squad-03-desafio-MCP-agentic).
- [ ] Link para repo anterior no README.md.
- [x] Verificar BEDROCK_MODEL_ID lido do `.env` — console/runtime agora mostram `global.anthropic.claude-haiku-4-5-20251001-v1:0`.
- [ ] Build estático (`next build`, `output: 'export'`) gerando `frontend/out`.
- [ ] Build e publicação no Amplify Hosting via `scripts/deploy-frontend.sh`.

## 6. Infraestrutura (infra/)

- [x] Escolher IaC: CDK (TypeScript) — definido, pasta `infra/` com stacks database/tools/agent/api/frontend.
- [x] Um único comando deve criar todo o ambiente: `cdk deploy --require-approval never` (sintetiza corretamente; deploy não executado para evitar custos AWS).
- [x] Frontend estático no Amplify Hosting (CloudFront/S3+OAC bloqueado por SCP nesta conta).
- [x] Cognito user pool sem auto cadastro (`AllowAdminCreateUserOnly`); usuários por convite.
- [x] Usuário do instrutor criado no Cognito pelo CDK (AwsCustomResource).
- [x] IAM de menor privilégio para Lambda, AgentCore Runtime, API Gateway, DynamoDB, S3, CloudFront, ECR.
- [x] Stack/recursos prefixados com `luiz-henrique` para não colidir.
- [x] Nenhum segredo no Git.
- [x] VPC pública (sem NAT Gateway para reduzir custo) + security group para AgentCore Runtime.
- [x] ECR repository para imagem do container do agente.
- [x] AgentCore Runtime via `cdk.CfnResource` (AWS::BedrockAgentCore::AgentRuntime, sem L2 CDK construct).

## 7. Testes e evidências

- [x] `cdk synth` executa sem erros.
- [x] Agente Strands com bedrock-agentcore SDK roda localmente (porta 3031, Bedrock real).
- [x] Frontend build estático compila (`frontend/out`).
- [x] Teste manual do agente local: listar catálogo, compra cartão/pix, limite excedido.
- [x] Validar/listar catálogo e compra usando as Lambdas reais (pós-deploy).
- [x] Login com usuário válido via Cognito (produção AWS).
- [ ] Requisição sem token → `401` (produção AWS).
- [ ] Compra com cartão de crédito (produção AWS).
- [ ] Compra com Pix (produção AWS).
- [ ] Tentativa de compra com limite excedido → rejeitada (produção AWS).
- [ ] Compra com `intencao_id` inválido → erro (produção AWS).
- [ ] Capturar screenshots/logs de cada evidência para o `README.md`.

## 8. Deploy

- [ ] Rodar o script IaC da pasta `infra/` (único comando).
- [ ] Verificar criação de: bucket, distribuição CloudFront, runtime do AgentCore, imagens no ECR, tabelas DynamoDB, logs.
- [ ] Aplicação no ar e acessível via CloudFront.

## 9. README da entrega

Preencher `Desafio-1/luiz-henrique/README.md` com:
- [x] Diagrama implementado.
- [x] Passo a passo de deploy.
- [x] Modelo usado (Bedrock Claude Haiku via AgentCore; temporariamente Nova 2 Lite até liberar acesso).
- [x] Modelagem do DynamoDB.
- [x] Resumo do IAM.
- [ ] Evidências: login, `401` sem token, compra com cartão, compra com Pix, limite excedido, `intencao_id` inválido.
- [x] Instruções de remoção.

## 10. Limpeza (após a correção)

- [ ] Destruir a stack (único comando de destroy).
- [ ] Confirmar no console que não restou: bucket, distribuição CloudFront, runtime do AgentCore, imagens no ECR, tabelas DynamoDB, logs.

## Status

- [x] Em andamento
- [ ] Concluído
