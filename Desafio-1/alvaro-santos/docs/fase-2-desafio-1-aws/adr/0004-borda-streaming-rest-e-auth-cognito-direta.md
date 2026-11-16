---
title: "ADR-0004: Borda Streaming em API Gateway REST e Autenticação Direta no Cognito"
status: aceito
type: adr
projeto: nexus-store-desafio-1
decisor: Álvaro Kayc
data_decisao: 2026-11-16
---

# ADR-0004: Borda Streaming em API Gateway REST e Autenticação Direta no Cognito

## 1. Contexto

O enunciado oficial do Desafio 1 (páginas 2 e 3) recomenda HTTP API com JWT authorizer no API Gateway e o pacote `@aws-amplify/ui-react` (`Authenticator`) no frontend, deixando claro que variações justificadas na documentação são aceitas.

Durante a implementação da borda (`infra/lib/api.ts`, `api/index.ts` e `frontend/src/services/`), duas exigências técnicas definiram o desenho:
1. O contrato do frontend React (`consumeNdjson`) depende de streaming HTTP contínuo (`application/x-ndjson`) sem buffering prematuro da resposta completa.
2. O frontend existente já possuía tela de login própria, gerenciamento de estado (`AuthContext`), validações de sessão e 24 testes unitários em Vitest sem dependência de `@aws-amplify/ui-react`.
3. A conta compartilhada `006739439488` recebeu bloqueio temporário de permissões `cloudfront:*`, exigindo alternância controlada entre a origem do CloudFront e `http://localhost:5173`.

## 2. Decisões

1. **Amazon API Gateway REST (`apigw.RestApi`) com `ResponseTransferMode.STREAM`:**
   - Em vez de HTTP API (`apigwv2.HttpApi`, que não suporta streaming de resposta via `LambdaIntegration` com `responseTransferMode: STREAM`), adotamos a REST API (`alvaro-chat-api`) integrada à Lambda `alvaro-chat-api-handler` com `awslambda.streamifyResponse` e `HttpResponseStream.from`.
   - Adicionamos `GatewayResponses` explícitos (`UNAUTHORIZED`, `ACCESS_DENIED`, `DEFAULT_4XX`, `DEFAULT_5XX`) com cabeçalhos `Access-Control-Allow-Origin` para que respostas `401` emitidas pelo `CognitoUserPoolsAuthorizer` cheguem legíveis ao navegador sem mascarar o erro de sessão como erro de CORS.

2. **Autenticação direta no Amazon Cognito via `USER_PASSWORD_AUTH` sem `@aws-amplify/ui-react`:**
   - O login em `frontend/src/services/authService.ts` envia `AWSCognitoIdentityProviderService.InitiateAuth` diretamente para `cognito-idp.<region>.amazonaws.com`, recebe o `IdToken` JWT (contendo a claim `sub`) e valida a expiração localmente em `me()`.
   - Os valores `VITE_API_URL`, `VITE_COGNITO_USER_POOL_ID` e `VITE_COGNITO_CLIENT_ID` não ficam fixos no código fonte (`frontend/src/config/env.ts`); são extraídos de `infra/cdk-outputs.json` para `frontend/.env.local` durante a execução de `scripts/deploy.sh`.

3. **Isolamento de `sessionId` e padrão `skipFrontendHost = true`:**
   - Cada sessão e cada ação de "Nova conversa" no React gera um `sessionId` UUID próprio enviado no body de `POST /api/chat`, evitando colisão de histórico na chave `:default` em `alvaro-conversas`.
   - Em alinhamento à diretriz oficial da coordenação (16/11/2026) de manter o frontend local e postergar o CloudFront para próximos workshops/desafios, `AgenticPaymentsStack` usa `skipFrontendHost = true` por padrão, liberando CORS para `http://localhost:5173`. O construto `FrontendHost` permanece preservado no código e pode ser ativado a qualquer momento via `-c skipFrontendHost=false` (`scripts/deploy.sh --with-cloudfront`).

## 3. Alternativas Consideradas e Trade-offs

- **HTTP API (`apigwv2`) + WebSocket API:** exigiria manter conexões stateful WebSocket (rotas `$connect`/`$disconnect`, tabela de conexões e gerenciamento de reconexão no cliente) ou abrir mão de streaming HTTP nativo. A REST API com `ResponseTransferMode.STREAM` preservou o mesmo contrato NDJSON da Fase 1.
- **Adicionar `aws-amplify` e `@aws-amplify/ui-react`:** substituiria o design próprio da tela de login e aumentaria o bundle do Vite sem ganho funcional para o fluxo `USER_PASSWORD_AUTH` de cliente público sem segredo.

## 4. Consequências

- **Positivas:** streaming NDJSON nativo validado ponta a ponta em produção (`HTTP/1.1 200 OK`, `Transfer-Encoding: chunked`), rejeição `401` na borda antes da invocação da Lambda, zero segredos ou IDs de infraestrutura fixos no código e compatibilidade integral com os 24 testes existentes do frontend.
- **Negativas / Mitigações:** o frontend roda localmente em `http://localhost:5173` conectado ao backend e Cognito na AWS, conforme documentado no `README.md`. Quando o CloudFront for utilizado em desafios futuros, basta executar `bash scripts/deploy.sh --with-cloudfront --profile alvaro-fellowship` para publicar o build no S3 privado com OAC.
