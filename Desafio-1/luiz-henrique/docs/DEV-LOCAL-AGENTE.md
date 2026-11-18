# Desenvolvimento local do agente

Verificado em **2026-11-17**. O agente local usa o **mesmo** `agent/index.ts` e o mesmo
Bedrock do runtime remoto. A diferença é a camada de transporte (HTTP local em vez de
AgentCore) e, opcionalmente, tools em memória.

## 1. O que roda

- `agent/index.ts` sobe um `BedrockAgentCoreApp` em `http://localhost:3031`.
- O handler `POST /invocations` exige o header
  `x-amzn-bedrock-agentcore-runtime-session-id` (ou `sessionId` no corpo) e recebe:
  `{ "prompt": "...", "usuario_id": "...", "messages": [...], "intencao_id": "..." }`.
  Sem o session id, o SDK responde `Missing sessionId`.
- `messages` é o caminho principal (roles `user`/`assistant`); `prompt` é fallback.
- O modelo é o Bedrock real (`BEDROCK_MODEL_ID`; o `.env` usa Haiku 4.5).
- Com os 3 ARNs configurados, as tools chamam as Lambdas implantadas. Sem ARNs, usa o
  fallback em memória.

## 2. Pré-requisitos

- Node 20+ e dependências.
  - `npm install` na raiz;
  - `npm --prefix agent install` (o `agent/` tem `package-lock.json` próprio);
  - `npm run setup` instala raiz + frontend, mas **não** instala o `agent/`.
- Credenciais AWS para o Bedrock. O perfil do projeto é `desafio-1`:
  `aws sso login --profile desafio-1`.
- Permissões: `bedrock:InvokeModel`/`Converse` no modelo e, se usar ARNs,
  `lambda:InvokeFunction` nas 3 tools.

## 3. Rodar sem ARNs (fallback local)

Bom para iterar prompt, fluxo e tool loop sem gravar no DynamoDB nem pagar Lambda.

```bash
cd Desafio-1/luiz-henrique
eval "$(scripts/aws-creds.sh)"          # credenciais para o Bedrock
export BEDROCK_MODEL_ID=us.anthropic.claude-haiku-4-5-20251001-v1:0
export AWS_REGION=us-east-1
unset TOOL_LISTAR_CATALOGO_ARN TOOL_REGISTRAR_INTENCAO_ARN TOOL_REALIZAR_COMPRA_ARN

npm run dev:agent
```

> `agent/index.ts` carrega o `.env` da **raiz** do projeto com `override: true`: no modo
> local, o `BEDROCK_MODEL_ID` do `.env` vence o valor exportado no shell. Para testar outro
> modelo, altere o `.env`. Se `scripts/aws-creds.sh` exportou credenciais estáticas, o
> `AWS_PROFILE` do `.env` é removido em runtime para o SDK não tentar resolver o SSO.

Em outro terminal:

```bash
curl -s -X POST http://localhost:3031/invocations \
  -H 'content-type: application/json' \
  -H 'x-amzn-bedrock-agentcore-runtime-session-id: local-dev' \
  -d '{
    "usuario_id": "dev-user",
    "messages": [
      { "role": "user", "content": [{ "type": "text", "text": "Quero comprar o Fone Bluetooth" }] }
    ]
  }'
```

A resposta inclui `reply`, `purchase`, `intencao_id` e `model`. Para continuar a conversa,
reenvie o array `messages` com os turnos anteriores.

> Verificado em 2026-11-17: o servidor sobe na porta 3031 e devolve `400` com
> `invalid_request` para payload vazio, sem chamar o Bedrock. O caminho completo com modelo
> exige credenciais AWS válidas.

### O que o fallback replica hoje

- ID `INT-XXXXXXXX` (8 hex), igual ao `registrar_intencao` remoto.
- `code`, `status`, `valor_centavos`, `expira_em`.
- Cancelamento em `LIMITE_EXCEDIDO` e `INTENCAO_EXPIRADA`.
- Saldo por usuário, iniciado em `SALDO_INICIAL_LOCAL` (fallback `LIMITE_COMPRA`, 500
  reais), debitado na compra.

O que ele **não** replica: DynamoDB, IAM, concorrência real, transação atômica, dados
persistidos entre reinícios e logs do runtime.

## 3.1 Fluxo local completo (sem API Gateway)

```bash
npm run test:local
```

O script:

1. sobe o agente local na porta 3031;
2. executa `monitor → cartão → LIMITE_EXCEDIDO/cancelada → fone → pix`;
3. verifica que a segunda compra criou um **novo** ID, pagou e não citou o ID antigo;
4. derruba o agente e mostra o log se algo falhar.

Por padrão usa o fallback em memória: não grava DynamoDB nem invoca Lambdas. Ainda consome
Bedrock (4 chamadas curtas). Para usar as Lambdas/DynamoDB reais:

```bash
USE_REAL_TOOLS=1 npm run test:local
```

O harness é o jeito mais rápido de validar prompt/tool loop antes do deploy.

## 4. Rodar com as Lambdas reais

Use quando precisar validar persistência, saldo e códigos de erro de verdade. Isso grava
em DynamoDB e invoca Lambdas (custo baixo, mas real).

```bash
cd Desafio-1/luiz-henrique
eval "$(scripts/aws-creds.sh)"
set -a; source .env; set +a
export AWS_REGION=us-east-1

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export TOOL_LISTAR_CATALOGO_ARN=arn:aws:lambda:$AWS_REGION:$ACCOUNT:function:luiz-henrique-listar-catalogo
export TOOL_REGISTRAR_INTENCAO_ARN=arn:aws:lambda:$AWS_REGION:$ACCOUNT:function:luiz-henrique-registrar-intencao
export TOOL_REALIZAR_COMPRA_ARN=arn:aws:lambda:$AWS_REGION:$ACCOUNT:function:luiz-henrique-realizar-compra

npm run dev:agent
```

Use um `usuario_id` que exista em `Usuarios` (ou o `sub` de um usuário de teste). O
`registrar_intencao` real grava no DynamoDB; limpe os itens depois se necessário.

## 5. Paridade com o remoto

| Aspecto | Local | Remoto |
|---|---|---|
| Código do agente | `agent/index.ts` | mesma imagem/`index.ts` |
| Modelo | Bedrock (`BEDROCK_MODEL_ID`) | mesmo env no runtime |
| Tools | fallback ou Lambdas reais | Lambdas reais |
| Prompt/tool loop | igual | igual |
| IDs/códigos | iguais desde esta rodada | iguais |
| Estado de conversa | harness simula `pending_intencao_id` | `Conversas`; a tool valida `Intencoes` |
| API Gateway/JWT/CORS | não | sim |
| DynamoDB/IAM | não (fallback) | sim |
| AgentCore session/logs | não | sim |
| Container arm64 | não | sim |

Para o bug de reutilização de ID, o local reproduz o comportamento do runtime porque o
estado problemático está no código do agente/API, não no transporte. Use o local para
validar o plano antes de cada deploy.

## 6. Confirmar modelo e logs (sem invocar Bedrock)

```bash
npm run check:model   # lê o BEDROCK_MODEL_ID do runtime implantado
npm run check:logs    # lista log groups/streams de agente e Lambdas
```

Ambos são read-only e exigem credenciais. `check:model` não chama o modelo; `check:logs` não
cria recursos.

## 6.1 WebSocket (parcial)

```bash
npm run test:ws
```

O script faz login Cognito, conecta em `wss://.../prod?token=...&conversa_id=...` e envia
“catalogo”. Hoje o `$connect` autentica e grava a conexão, mas o `$default` retorna
`Internal server error`; o chat principal continua via REST. Continuação em
[`WS-NEXT.md`](WS-NEXT.md).

## 7. Limitações e segurança

- Não exercita API Gateway, JWT, CORS, DynamoDB real, IAM, imagem Docker, sessão do
  AgentCore nem logs do runtime.
- O servidor sobe em `0.0.0.0:3031`; use só em rede confiável.
- Não exponha a porta 3031 publicamente.
- O modo local ainda consome Bedrock (custo por token). Para iterar prompt, prefira frases
  curtas e poucas chamadas.
- Não coloque ARNs, account ID ou credenciais no frontend.
