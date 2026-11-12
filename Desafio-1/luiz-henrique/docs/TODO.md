# TODO — Desafio 1: Agente de Pagamentos na AWS

Sprint 2 · Trilha Pagamentos Agênticos · Trabalho individual · Branch `fellow/luiz-henrique-desafio-1`

Pasta de trabalho: `Desafio-1/luiz-henrique/` com `frontend/ api/ agent/ tools/ infra/ README.md`.

Região: `us-east-1`. Prefixo dos recursos: `luiz-henrique`.

## 0. Preparação (pré-requisitos)

- [x] Aceitar convite do IAM Identity Center (usuário + senha + MFA). — login_session presente em ~/.aws/config (<test-email>)
- [x] Instalar AWS CLI v2 (>= 2.22.0). — aws-cli/2.39.5
- [x] Configurar perfil SSO: `aws configure sso` (profile `desafio-1`, região `us-east-1`). — presente em ~/.aws/config
- [x] `export AWS_PROFILE=desafio-1` em cada terminal de deploy. — perfil configurado; exportar por terminal
- [x] `aws sso login` e `aws sts get-caller-identity` para confirmar a conta. — login_session presente
- [x] Criar branch `fellow/luiz-henrique-desafio-1` (já criada) e trabalhar somente em `Desafio-1/luiz-henrique/`.
- [x] Não commitar segredos nem chaves de acesso; nenhum `*` nem `AdministratorAccess` no IAM. — nada commitado ainda

## 1. Modelo de dados (DynamoDB)

- [x] Definir modelagem do DynamoDB: usuários, conversas, intenções/transações.
- [x] Escrever o diagrama de modelagem no `docs/TODO.md` ou `README.md`.
- [x] Tabelas: `Usuarios`, `Conversas`, `Intencoes`, `Catalogo` (criadas em MiniStack local).
- [x] Chaves de partição e sort definidas; índices secundários se necessário.
- [x] Escrita condicional para evitar duplicidade de pagamento/limite.

## 2. Ferramentas do agente (tools/)

- [x] `listar_catalogo` — retorna catálogo de produtos disponíveis.
- [x] `registrar_intencao` — salva intenção de compra no DynamoDB (condicional).
- [x] `realizar_compra` — efetua pagamento com cartão ou Pix; valida limite e intenção.
- [x] Cada tool em sua própria Lambda com IAM de menor privilégio.
- [x] Tratamento de erros: `intencao_id` inválido, limite excedido, pagamento rejeitado.

## 3. Agente Strands (agent/)

- [x] Implementar agente Strands com as 3 tools acima.
- [x] Modelo: Amazon Bedrock (Claude Haiku) via AgentCore Runtime (local: MiniStack → llama.cpp/Qwen3.5).
- [x] Regras de negócio da Fase 1 inalteradas.
- [ ] Deploy do agente no Bedrock AgentCore Runtime (pendente AWS).
- [ ] Imagem de container no ECR (para remoção posterior).

## 4. API (api/)

- [x] API Gateway (REST) com autorizador JWT Cognito.
- [x] Lambda do chat que chama o agente Strands via Lambda Invoke.
- [x] `usuario_id` vem do `sub` do token Cognito, nunca do corpo nem do modelo.
- [x] Resposta `401` sem token válido.
- [ ] CORS aceita apenas o domínio do CloudFront.

## 5. Frontend (frontend/)

- [x] Chatbot com login Cognito e envio de JWT como Bearer token.
- [x] Build e upload no bucket S3 privado (pendente deploy AWS).
- [ ] Invalidação do CloudFront após upload.

## 6. Infraestrutura (infra/)

- [x] Escolher IaC: CDK (TypeScript) — definido, pasta `infra/` com stacks database/tools/agent/api/frontend.
- [x] Um único comando deve criar todo o ambiente: `cdk deploy --require-approval never` (sintetiza corretamente; deploy local bloqueado por bootstrap do CDK/MiniStack).
- [x] CloudFront + S3 (frontend estático, OAC, bucket privado) — código escrito, não testado em AWS.
- [x] Cognito user pool sem auto cadastro (`AllowAdminCreateUserOnly`); usuários por convite.
- [ ] Criar usuário no Cognito com o e-mail do instrutor.
- [x] IAM de menor privilégio para Lambda, API Gateway, DynamoDB, S3, CloudFront.
- [x] Stack/recursos prefixados com `luiz-henrique` para não colidir.
- [x] Nenhum segredo no Git.

## 7. Testes e evidências

- [x] Tool Lambdas testadas localmente contra MiniStack (listar_catalogo, registrar_intencao, realizar_compra).
- [x] Agente Strands testado localmente contra MiniStack (Bedrock Converse + tool use orquestração).
- [x] API Lambda testada localmente contra MiniStack (JWT autenticação + invoke agent).
- [ ] Login com usuário válido (JWT obtido via Cognito).
- [ ] Requisição sem token → `401`.
- [ ] Compra com cartão de crédito.
- [ ] Compra com Pix.
- [ ] Tentativa de compra com limite excedido → rejeitada.
- [ ] Compra com `intencao_id` inválido → erro.
- [ ] Capturar screenshots/logs de cada evidência para o `README.md`.

## 8. Deploy

- [ ] Rodar o script IaC da pasta `infra/` (único comando).
- [ ] Verificar criação de: bucket, distribuição CloudFront, runtime do AgentCore, imagens no ECR, tabelas DynamoDB, logs.
- [ ] Aplicação no ar e acessível via CloudFront.

## 9. README da entrega

Preencher `Desafio-1/luiz-henrique/README.md` com:
- [x] Diagrama implementado.
- [x] Passo a passo de deploy.
- [x] Modelo usado (Bedrock Claude Haiku via AgentCore).
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
