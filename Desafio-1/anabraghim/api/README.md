# api/

Lambdas em TypeScript (Node 22, arm64) atrás do API Gateway REST `ana-braghim-api` (stage `prod`), com autorizador Cognito em todas as rotas.

```bash
npm ci
npm test          # vitest, com DynamoDB e AgentCore mockados (não acessa a AWS)
npm run typecheck
npm run build     # gera infra/build/api/<lambda>/index.mjs (esbuild)
```

| Rota | Lambda | Permissões (role) |
|---|---|---|
| `POST /api/chat` | [`ana-braghim-api-chat`](src/chat.ts), com response streaming | `conversas`: Query e PutItem; `bedrock-agentcore:InvokeAgentRuntime` no runtime do agente |
| `GET /api/conversas` | [`ana-braghim-api-conversas`](src/conversas.ts) | `conversas`: Query |
| `GET /api/perfil` | [`ana-braghim-api-perfil`](src/perfil.ts) | `usuarios`: GetItem |

**Identidade:** o `usuario_id` vem sempre de `requestContext.authorizer.claims.sub`, preenchido pelo autorizador depois de validar o JWT. Um `usuario_id` no corpo é ignorado. Sem `sub`, a Lambda responde 401, como segunda barreira depois do autorizador.

## `POST /api/chat`

Corpo: `{ "mensagem": "quero 2 fones" }`, com 1 a 4000 caracteres.

Resposta `200` com `Content-Type: application/x-ndjson`, uma linha JSON por evento, enviada em tempo real:

```
{"tipo":"ferramenta","nome":"registrar_intencao"}
{"tipo":"texto","texto":"Registrei a intenção "}
{"tipo":"texto","texto":"2f1c…, total BRL 499.80."}
{"tipo":"fim"}
```

| Evento | Significado para o frontend |
|---|---|
| `texto` | Acrescentar ao balão do assistente |
| `ferramenta` | Mostrar "consultando o catálogo..." (opcional) |
| `fim` | Turno concluído e gravado no histórico |
| `erro` | Mostrar `mensagem`. O turno **não** foi gravado e o usuário pode repetir. O evento também chega se a resposta foi gerada mas não pôde ser salva. |
| `pulso` | Ignorar. Vai a cada 15 s durante o streaming só para manter a conexão viva em proxies que cortam respostas paradas (o CloudFront corta após 60 s sem bytes). |

Antes de o stream abrir, os erros voltam como JSON `{ "erro": "..." }`: `401` sem identidade, `400` com corpo inválido e `502` se o histórico ou o agente falharem.

Fluxo:
1. Lê do DynamoDB as últimas 399 mensagens. Se o corte cair no meio de um turno, o histórico começa no próximo texto do usuário.
2. Acrescenta a nova mensagem e chama `InvokeAgentRuntime` com `{ usuario_id, mensagens }`, `qualifier: DEFAULT` e `runtimeSessionId = sessao-<sub>`. É uma sessão por usuário, então a microVM nunca é compartilhada entre usuários.
3. Repassa os eventos `texto`/`ferramenta` do SSE do agente.
4. No evento `fim`, valida as `mensagens_novas` (começam no texto do usuário e terminam no assistente) e as grava numa transação, tudo ou nada.

Cada mensagem é um item com SK `msg#<início do turno ISO>#<id do turno>#<posição>`. Assim, dois turnos simultâneos (duas abas) ficam em blocos separados e válidos.

## `GET /api/conversas`

`{ "mensagens": [ { "papel": "usuario" | "assistente", "texto": "...", "criado_em": "..." } ] }`, em ordem cronológica, com as últimas 399 mensagens. Chamadas e resultados de tools e o raciocínio do modelo ficam gravados para o agente, mas não aparecem aqui.

## `GET /api/perfil`

`{ "email": "...", "limite_total": 500, "limite_disponivel": 250.1, "moeda": "BRL" }`, com valores em reais. O `email` vem da claim do **ID token**. Um usuário que ainda não tem registro em `usuarios` vê o limite padrão de R$ 500,00, o mesmo que a tool grava na primeira compra.

## API Gateway

- **Autorizador:** `COGNITO_USER_POOLS` no header `Authorization` (ID token). Sem token, ou com token inválido ou expirado, o próprio API Gateway responde `401 {"erro":"Sessão expirada ou inválida. Entre novamente."}` e a Lambda nem é chamada.
- **Integrações:** `POST /api/chat` usa Lambda proxy com `ResponseTransferMode: STREAM`, timeout de 190 s acima do limite de 29 s. As outras rotas usam Lambda proxy comum.
- **Erros do próprio API Gateway**, no formato `{ "erro": "..." }`:

  | Situação | Status |
  |---|---|
  | Rota inexistente | 404 |
  | Acesso negado | 403 |
  | Limite de requisições | 429 |
  | Outros 4XX e 5XX | mensagem genérica |
- **Limite:** 10 requisições por segundo, com picos de 20, no stage.
- **Invocação das Lambdas:** cada uma só pode ser invocada por esta API, neste stage, neste método e nesta rota (`SourceArn`).
- **Sem CORS:** o frontend chama `/api/*` na **mesma origem** do site, e quem repassa para o stage `prod` é o CloudFront (modo hospedado) ou o proxy do Vite (modo local). O navegador não faz chamada cross-origin, então não há rota `OPTIONS` nem `Access-Control-Allow-Origin`. Chamadas de outros sites continuam bloqueadas pela política de mesma origem do navegador, e qualquer cliente fora do navegador precisa de um JWT válido.
