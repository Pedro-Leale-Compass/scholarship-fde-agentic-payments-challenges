# Deploy Findings — Desafio 1

Live-state review of `Desafio1Stack` (account `<account-id>`, `us-east-1`), 2026-11-17.
Evidence collected with `aws` CLI plus an end-to-end call through API Gateway.

## Fix log (v0.0.1 — "chat works")

1. **Bedrock IAM (P0)** — commit `7b44307` had replaced the valid `bedrock:` actions with
   `bedrock-runtime:`, leaving the runtime role unable to invoke any model. Restored
   `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`, `bedrock:Converse` and
   added `bedrock:ConverseStream`.
2. **Model fallback (P0/P1)** — restored
   `MODEL_ID = process.env.BEDROCK_MODEL_ID || 'global.amazon.nova-2-lite-v1:0'`, so a
   synth without `.env` still produces a working agent.
3. **Claude Haiku 4.5 (P2)** — foundation-model ARNs are now derived from `MODEL_ID`
   (profile prefix stripped); `.env`/`.env.example` set to
   `us.anthropic.claude-haiku-4-5-20251001-v1:0`, with Nova 2 Lite as documented
   fallback. Deployed at runtime v5 and verified.
4. **Environment loading (P3)** — new `infra/lib/env.ts` locates `.env` by walking upward
   (works from `infra/lib` and `infra/dist/lib`), supports `ENV_FILE`, and `bin/desafio-1.ts`
   loads it once before any stack reads `process.env`. Removed module-level dotenv side
   effects; `cdk diff` confirmed no template drift.
5. **Runtime error responses** — removed the SDK `requestSchema` (its Zod failure path
   replies with an object, which fails under SSE and surfaces as an opaque 500). The
   handler now validates `prompt`/`usuario_id` and returns JSON strings with
   `invalid_request` (400) or `agent_error` (502); the chat Lambda propagates the embedded
   `statusCode`. Malformed JSON still gets a real HTTP 400 from Fastify.
6. **Runtime invocation contract** — documented the required
   `{"prompt": "...", "usuario_id": "..."}` payload for console/CLI testing.
7. **Frontend** — three known UI issues recorded in `docs/TODO.md` (username instead of
   UUID, missing space after "Você", auto-scroll), not fixed yet.
8. **Identifier scrub** — account id, API/runtime ARNs, REST API id and Cognito ids were
   removed from the tracked files and from this branch's history. The real values live
   only in the local, gitignored `.env` (`AWS_ACCOUNT_ID`, `API_URL`,
   `COGNITO_USER_POOL_ID`, `COGNITO_USER_POOL_CLIENT_ID`, `AGENT_RUNTIME_ID`,
   `AGENT_RUNTIME_ARN`). `infra/cdk.context.json` (account-keyed) was removed and is now
   gitignored.

## Secrets audit (2026-11-17)

- No AWS access keys (`AKIA…`/`ASIA…`), session tokens, or private keys in the current tree
  or in any commit.
- `.env` was never tracked; only `.env.example` (placeholders). `tests/postman-environment.json`
  and `infra/cdk.out/` are gitignored.
- **Found and fixed:** the Cognito test-user password was committed in
  `tests/postman-collection.json` (`d62e14e`), and an older variant in `.env.example`
  (`f00f725`). The value was removed from the tracked collection; the test-user password
  was rotated in Cognito and the local `.env`/ignored Postman environment were updated.
  The old values remain in git history (history rewrite/force-push was not performed) but
  are no longer valid credentials.
- **Note:** test-user creation was moved out of CDK to `scripts/create-test-user.sh`
  (`npm run dev:create-test-user`); the password is read from `.env` and no longer appears
  in the synthesized CloudFormation template.

## Agent invocation contract (console, CLI, API)

This is the contract implemented in `agent/index.ts` (`invocationHandler.requestSchema`).
The runtime rejects anything that does not match it.

Required body (both fields, exact names):

```json
{
  "prompt": "liste o catálogo de produtos",
  "usuario_id": "console-test-user"
}
```

- `prompt` — user text sent to the Strands agent.
- `usuario_id` — identity used by the tools. It is NOT inferred by the runtime; the
  caller must provide it. In production the chat Lambda fills it from the Cognito JWT
  `sub`; in the console/CLI you choose it manually.

### AWS console (AgentCore Runtime test)

Bedrock AgentCore → Runtimes → `luiz_henrique_agent` → endpoint `DEFAULT` (live version 3)
→ Test/Invoke, and paste the JSON above. The console generates the runtime session id.

Observed results (2026-11-17, after the error-response fix):

| Payload | Result |
|---------|--------|
| `{"prompt":"...","usuario_id":"console-test-user"}` | success reply with 8 products |
| `{"prompt":"..."}` (missing `usuario_id`) | `{"statusCode":400,"body":{"ok":false,"code":"invalid_request","error":"missing or blank required field(s): usuario_id",...}}` |
| `{"message":"..."}` (wrong key) | same `invalid_request` body naming `prompt` and `usuario_id` |
| malformed JSON | HTTP `400` from Fastify's parser, before the handler runs |

### Error responses

`agent/index.ts` originally used the SDK's `requestSchema` (Zod). That path is broken
under SSE: the SDK replies with a JSON *object*, which Fastify refuses
(`Attempted to send payload of invalid type 'object'`), so the console/TUI saw an opaque
`500`. The schema was removed and validation moved into `process`, which always returns a
JSON string:

| Case | Body returned by the runtime |
|------|------------------------------|
| missing/blank `prompt` or `usuario_id` | `{"statusCode":400,"body":{"ok":false,"code":"invalid_request","error":"missing or blank required field(s): ...","required":{...}}}` |
| Bedrock/tool failure | `{"statusCode":502,"body":{"ok":false,"code":"agent_error","error":"<real error message>"}}` |
| success | `{"ok":true,"usuario_id":"...","reply":"...","model":"..."}` |

The AgentCore handler cannot set an HTTP status: handler responses are sent with HTTP
`200`. The embedded `statusCode` is honored by the chat Lambda (`api/index.ts`), which
propagates `400`/`502` to API clients. Malformed JSON is still rejected with a real HTTP
`400` by Fastify before the handler.

### AWS CLI

```bash
cat > /tmp/payload.json <<'EOF'
{"prompt":"liste o catálogo de produtos","usuario_id":"console-test-user"}
EOF

aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn arn:aws:bedrock-agentcore:us-east-1:<account-id>:runtime/<agent-runtime-id> \
  --runtime-session-id "manual-test-$(date +%s%N)-aaaaaaaaaaaaaaaaaaaa" \
  --payload fileb:///tmp/payload.json \
  --content-type application/json --accept application/json \
  --profile desafio-1 --region us-east-1 /tmp/response.bin
```

`--runtime-session-id` is required and must be unique per call (AgentCore enforces a
minimum length; the UUID suffix above keeps it unique and long enough).

### Through the deployed API (production path)

```bash
TOKEN=$(aws cognito-idp initiate-auth \
  --profile desafio-1 --region us-east-1 \
  --client-id "$COGNITO_CLIENT_ID" --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME="$TEST_EMAIL",PASSWORD="$TEST_PASSWORD" \
  --query AuthenticationResult.IdToken --output text)

curl -X POST "$API_URL/chat" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"messages":[{"role":"user","content":[{"text":"liste o catálogo de produtos"}]}]}'
```

Here `usuario_id` is not sent by the client: the Lambda extracts `sub` from the token
and builds the `{prompt, usuario_id}` payload itself. Without a valid token the API
returns `401` before reaching the runtime.

## Verified working

- CloudFormation stack: `UPDATE_COMPLETE`; AgentCore runtime: `READY`, version 3, endpoint `DEFAULT` on live version 3.
- `POST /chat` without token → `401` with the correct CORS headers; `OPTIONS /chat` → `204` with the allowed origin.
- Cognito login (`USER_PASSWORD_AUTH`) succeeds for the test user.
- DynamoDB tables exist and `luiz-henrique-catalogo` is seeded with 8 items.
- Chat Lambda has `bedrock-agentcore:InvokeAgentRuntime` on the runtime ARN and endpoint ARN.

## P0 — Agent returns 500 on every chat

Reproduce:

```
POST <api-url>/chat   -> agent_error / 502
Direct InvokeAgentRuntime with the same payload                            -> RuntimeClientError (500)
```

Runtime log:

```
ModelError: ... is not authorized to perform:
bedrock:InvokeModelWithResponseStream on resource:
arn:aws:bedrock:us-east-1:<account-id>:inference-profile/global.amazon.nova-2-lite-v1:0
because no identity-based policy allows the bedrock:InvokeModelWithResponseStream action
```

Root cause: commit `7b44307` ("use bedrock-runtime service for Converse API", 2026-11-16 20:59)
changed the IAM actions from `bedrock:` to `bedrock-runtime:`. Bedrock Runtime's IAM
service prefix is `bedrock`; `bedrock-runtime:` is not a real action namespace, so the
statement grants nothing. The previous working commit (`935789a`) used
`bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`, `bedrock:Converse`.

Fix: restore the `bedrock:` prefix (and add `bedrock:ConverseStream`, which Strands uses
for streamed Claude responses).

Status: **fixed, deployed and verified** (2026-11-17 00:41 UTC). End-to-end call through
API Gateway with a Cognito ID token returned `200` with a catalog reply from Nova 2 Lite:

```json
{"ok":true,"usuario_id":"04b8e478-...","reply":"Aqui está o catálogo de produtos disponíveis: 1. **Fone Bluetooth** - R$ 199,90 ...","model":"global.amazon.nova-2-lite-v1:0"}
```

The tools ran for real against DynamoDB (8 seeded products). The first deploy attempt
failed with a transient `Uploaded file must be a non-empty zip` on the two provider
Lambdas; the S3 asset was valid, and the immediate retry succeeded without changes.

Files: `infra/lib/agent-stack.ts` (Bedrock policy statement).

## P1 — Model selection no longer has the Nova fallback

Commit `89c6380` removed `const MODEL_ID = process.env.BEDROCK_MODEL_ID || 'global.amazon.nova-2-lite-v1:0'`
and made `BEDROCK_MODEL_ID` mandatory. Combined with the `.env` loading problems below,
a synth from a different CWD fails with `BEDROCK_MODEL_ID environment variable is not defined`.

Fix (priority 0, interim): restore the hardcoded Nova fallback. The model id itself was
not the cause of the 500 — the deployed env already had
`BEDROCK_MODEL_ID=global.amazon.nova-2-lite-v1:0`.

## P2 — Foundation-model ARNs hardcoded to Nova

`infra/lib/agent-stack.ts` derived the inference-profile ARN from `MODEL_ID` but hardcoded
`FOUNDATION_MODEL_ID = 'amazon.nova-2-lite-v1:0'`. Switching `.env` to the Claude Haiku
profile (`us.anthropic.claude-haiku-4-5-20251001-v1:0`) would have produced
`AccessDenied` because the Claude foundation-model ARNs were absent.

Status: **fixed, deployed and verified** (2026-11-17 01:05 UTC, runtime v5). The stack now
derives the foundation model id from `MODEL_ID` (strips the `global.`/`us.`/`eu.`/`apac.`
profile prefix), so the policy grants:

- `arn:aws:bedrock:us-east-1:829...:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`
- `arn:aws:bedrock:::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`
- the same foundation model in `us-east-1`, `us-east-2` and `us-west-2`

Both the console/CLI contract and the API `/chat` path returned a catalog answer with
`"model":"us.anthropic.claude-haiku-4-5-20251001-v1:0"`. Nova 2 Lite remains the
hardcoded fallback when `BEDROCK_MODEL_ID` is unset.

## P3 — `.env` loading is fragile

- `infra/bin/desafio-1.ts:7` calls `dotenv.config()` with the default path, which resolves
  relative to the CWD (`infra/`), where no `.env` exists.
- It only works because `infra/lib/agent-stack.ts:12` loads `../../.env` as a module
  side effect. `TEST_PASSWORD` and `TEST_EMAIL` in `desafio-1-stack.ts` depend on that
  side effect.
- The path is `__dirname`-relative, so it breaks when the compiled output in
  `infra/dist/lib` is executed instead of the TypeScript source.
- Without `TEST_PASSWORD`, the deploy succeeds but silently skips creating the test user.

Fix: a single explicit loader (fixed absolute path from the repo root, or
`CDK_PROJECT_ROOT`) executed before any stack module reads `process.env`; fail fast with
a clear message.

## P4 — Frontend is local-only

There is no `frontend-stack.ts`; no S3/CloudFront/Amplify resource is deployed.
`frontendUrl` is hardcoded to `http://localhost:3000` (`infra/lib/desafio-1-stack.ts:49`)
and both the API CORS config (`infra/lib/api-stack.ts:84`) and the chat Lambda
`FRONTEND_URL` use it. This is the accepted interim design; any hosted frontend will need
this value to become dynamic (e.g. derived from the hosting distribution).

## P5 — Smaller issues

- `ecr:GetAuthorizationToken` uses `Resource: "*"` (`infra/lib/agent-stack.ts:82-87`),
  contrary to the "no wildcard" rule (the action does not support resource scoping, but
  it should be documented as an accepted exception).
- `AWSLambdaBasicExecutionRole` is attached to the AgentCore runtime role
  (`infra/lib/agent-stack.ts:64-67`); it is a Lambda managed policy and not required.
- `infra/test/desafio-1.test.ts` is a no-op (unused import, `expect(true).toBe(true)`);
  it provides no synth coverage.
- `docs/TODO.md` claims Amplify Hosting, VPC/security group and `CfnAgentRuntime`; the
  code uses a custom resource and deploys no frontend or VPC.
- Root `README.md` says `npm install` at the root is enough, but `infra/` dependencies
  must also be installed for `cdk synth`/`deploy`.
- Duplicate stack outputs (`AgentStackAgentRuntimeArn*`, `AgentStackEcrRepositoryUri*`)
  are emitted from both the construct and the stack; harmless noise.

## Action plan

| Priority | Item | State |
|----------|------|-------|
| P0 | Restore `bedrock:` IAM actions (+ `ConverseStream`) | done |
| P0 | Restore hardcoded Nova model fallback | done |
| P0 | Structured runtime error responses (validation + agent errors) | done, deployed (runtime v4) |
| P1 | Deploy and verify an end-to-end chat request | done |
| P2 | Derive foundation-model permissions from `MODEL_ID` | done, deployed (runtime v5, Claude Haiku 4.5) |
| P3 | Single, robust `.env` loader with fail-fast validation | done (no template diff) |
| P4 | Dynamic frontend URL (when the frontend is hosted) | deferred |
| P5 | Cleanup: IAM wildcard note, managed policy, real synth test, docs | pending |

## Fix log v0.0.2 — registro de usuários e saldo transacional (2026-11-17)

1. **Registro em `Usuarios`** — a Lambda do chat agora faz lazy upsert por `sub` + `email`
   (`api/index.ts`, `ensureUsuario`), com `limite_centavos` padrão de 50000. Role do chat
   ganhou `dynamodb:GetItem`/`PutItem`/`UpdateItem` apenas em `Usuarios`.
2. **Convite por e-mail** — `scripts/invite-user.sh` (`npm run user:invite`) cria o usuário
   no Cognito, deixa o Cognito enviar o convite (template `userInvitation` no CDK) e grava
   o saldo em `Usuarios`. `scripts/set-limit.sh` (`npm run user:set-limit` /
   `user:reset-limit`) ajusta o saldo em reais.
3. **Compra transacional** — `realizar_compra` usa `TransactWriteItems`: baixa de
   `limite_centavos` (condição `>= valor` e `status = ativo`) + pagamento da intenção
   (condição `status = pendente`). Retorna os códigos da Fase 1
   (`LIMITE_EXCEDIDO`, `INTENCAO_JA_PAGA`, `INTENCAO_EXPIRADA`, `INTENCAO_INVALIDA`,
   `METODO_INVALIDO`) e valida dono e expiração.
4. **IAM (P0 do novo bloco)** — `TransactWriteItems` é autorizado por
   `dynamodb:UpdateItem`, não por `dynamodb:TransactWriteItems`. Sem `UpdateItem` a
   Lambda falhava com `AccessDeniedException` mascarado em 500. Política corrigida e
   redeployada.
5. **Policy por tool** — a policy compartilhada das tools foi substituída por uma por
   Lambda: `listar_catalogo` só `Catalogo`; `registrar_intencao` só `PutItem` em
   `Intencoes`; `realizar_compra` `GetItem`/`UpdateItem`/`TransactWriteItems` em
   `Intencoes` + `Usuarios`.
6. **`ClientRequestToken` removido** — reaproveitar o token com parâmetros diferentes
   gerava `IdempotentParameterMismatchException`; as condições `pendente` + `limite >= valor`
   já garantem idempotência.

Verificado no ambiente real:

- `npm run user:invite -- <email> 500` → usuário `FORCE_CHANGE_PASSWORD` no Cognito e item
  em `Usuarios` com `limite_centavos=50000`, `origem=convite`.
- `npm run user:set-limit -- <email> 750` e `user:reset-limit` → 500 → 750 → 500.
- Lambda `luiz-henrique-realizar-compra` com saldo 10000 e intenção de 5000 →
  `COMPRA_APROVADA`; saldo 5000, gasto 5000; retry → `INTENCAO_JA_PAGA`.
- Lambda do chat com claims `sub`/`email` (claims sintéticas) → item criado com
  `origem=lazy`.

## Fix log v0.0.3 — prompt, tool calling e validação (2026-11-17)

1. **Prompt reescrito** com o fluxo de checkout do repo anterior (registrar intenção →
   mostrar `intencao_id` → perguntar pagamento → pagar) e a regra explícita de não confundir
   intenção pendente com compra paga.
2. **Guard determinístico** no runtime: a resposta só pode dizer "aprovada/confirmada/paga"
   se `realizar_compra` retornou `ok: true` na mesma invocação.
3. **Fallback determinístico**: se o usuário confirma o pagamento e o modelo não chama
   `realizar_compra`, o runtime chama a tool com o último `intencao_id` da conversa.
4. **Tool calling**: `temperature: 0`, descrições de tool mais específicas, uma tool por vez
   (as tools têm efeito colateral). Detalhes em `docs/MODELO-BEDROCK-TOOLS.md`.
5. **Testes automatizados**: `npm run test:agent` (3 testes, com usuário temporário e
   asserções no DynamoDB). Resultado: `pass 3, fail 0`.
6. **Logging**: `realizar_compra` e `registrar_intencao` logam
   `{tool, usuario_id, intencao_id, statusCode/code}` para diagnóstico.

## Fix log v0.0.4 — turnos fabricados (2026-11-17)

1. **Causa**: a Lambda enviava `messages` estruturados, mas o runtime usava apenas o
   `prompt` achatado (`user: ...`), e o modelo continuava o transcript inventando falas.
2. **Correção**: runtime passou a usar `MessageData[]` no `agent.stream` quando `messages`
   está presente; `prompt` virou fallback.
3. **Prompt**: regra explícita para responder só à última mensagem e nunca escrever
   `user:`/`assistant:`/`human:`/`ai:`/`system:`.
4. **Sanitizer**: `stripFabricatedTurns` corta a resposta no primeiro turno falso; se a
   resposta inteira for transcript, devolve mensagem neutra.
5. **Teste**: `tests/agent.test.mjs` agora falha se a resposta tiver linha de turno
   fabricado. Resultado: `pass 3, fail 0`.

## Fix log v0.0.5 — IDs inventados e intenções canceladas (2026-11-17)

1. **Grounding de ID**: `groundIntencaoIds` substitui UUIDs divergentes e placeholders
   (`intencao_1`) pelo último `intencao_id` real da invocação.
2. **Tool boundary**: `realizar_compra` recusa IDs não-UUID; se houve registro na
   invocação, usa o ID real.
3. **Cancelamento**: `LIMITE_EXCEDIDO` e `INTENCAO_EXPIRADA` marcam a intenção como
   `cancelada` com `motivo_falha`; o erro inclui `status: "cancelada"`.
4. **Prompt**: regras 10 e 11 (não inventar ID; não reutilizar intenções canceladas/
   expiradas/pagas).
5. **Histórico**: API limita a 12 últimas mensagens.
6. **Testes**: UUIDs da resposta precisam existir no DynamoDB; intenção acima do limite
   precisa ficar `cancelada`.

## Fix log v0.0.6 — segunda compra, IDs curtos e prompt enxuto (2026-11-17)

1. **Prompt** reescrito em 6 seções curtas (~30 linhas), removendo as 11 regras
   acumuladas e a auto-verificação que estimulava a mensagem genérica.
2. **IDs curtos** `INT-XXXXXXXX` em `registrar_intencao`; UUID antigo segue válido.
3. **`Usuarios.ultima_intencao_id`**: API persiste o último ID e o reenvia no próximo
   turno; o runtime usa como fallback e na validação da tool.
4. **Histórico**: 12 mensagens + remoção das mensagens do guard para não contaminar o
   few-shot.
5. **Grounding**: `INT-...`/UUID divergentes e `intencao_N` são substituídos pelo ID real.
6. **Teste**: suíte agora faz duas compras (fone e teclado) após uma compra confirmada e
   verifica que a segunda é paga e o saldo é debitado duas vezes.

## Fix log v0.0.7 — fallback de pagamento e erro explícito (2026-11-17)

1. **Causa raiz**: `completePaymentFallback` lia a linha `user: Pix.` do prompt achatado e o
   regex exigia que a mensagem começasse com `pix`/`cartão`. Com o prefixo `user:`, um
   "Pix." isolado não acionava o fallback; o modelo dizia "aprovada" e o guard respondia.
2. **Correção**: o prefixo `user:` é removido antes de ler a forma de pagamento. "Pix." e
   "Cartão." agora acionam o fallback determinístico.
3. **Erro explícito**: o guard agora responde `Erro: ...` com explicação educacional
   ("o agente iria confirmar a compra para você sem registrar no backend"), e a UI exibe
   mensagens que começam com `Erro:` em vermelho (`role="alert"`).
4. **Testes**: `npm run test:agent` cobre a segunda compra com "Pix."; resultado `pass 3,
   fail 0`.
