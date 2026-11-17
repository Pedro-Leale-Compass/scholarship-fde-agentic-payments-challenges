# Desenvolvimento local do agente (sem deploy)

Objetivo: iterar prompt/loop do agente em segundos, sem buildar imagem Docker nem
atualizar o AgentCore Runtime. O agente local chama o Bedrock (Haiku) direto e as tools
pelo ARN das Lambdas já implantadas.

## O que roda local

- `agent/index.ts` cria um `BedrockAgentCoreApp` (Fastify) em `http://localhost:3031`.
- O handler `POST /invocations` recebe o mesmo payload do runtime:
  `{"prompt": "...", "usuario_id": "...", "messages": [...], "intencao_id": "..."}`.
- O modelo é o Bedrock real (`us.anthropic.claude-haiku-4-5-20251001-v1:0`).
- As tools são chamadas pelo ARN; sem ARN, o agente usa fallbacks em memória.

## Pré-requisitos

- Credenciais AWS válidas (`aws sso login` ou `scripts/aws-creds.sh`).
- Permissões: `bedrock:InvokeModel` no perfil/modelo e `lambda:InvokeFunction` nas 3 tools.
- Node 20+ e dependências do `agent/` instaladas.

## Fase 0 — loop manual (funciona hoje)

```bash
cd Desafio-1/luiz-henrique/agent
eval "$(bash ../scripts/aws-creds.sh)"
set -a; source ../.env; set +a
export BEDROCK_MODEL_ID=us.anthropic.claude-haiku-4-5-20251001-v1:0
export AWS_REGION=us-east-1

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export TOOL_LISTAR_CATALOGO_ARN=arn:aws:lambda:$AWS_REGION:$ACCOUNT:function:luiz-henrique-listar-catalogo
export TOOL_REGISTRAR_INTENCAO_ARN=arn:aws:lambda:$AWS_REGION:$ACCOUNT:function:luiz-henrique-registrar-intencao
export TOOL_REALIZAR_COMPRA_ARN=arn:aws:lambda:$AWS_REGION:$ACCOUNT:function:luiz-henrique-realizar-compra

npm run dev
```

Em outro terminal:

```bash
curl -N -X POST http://localhost:3031/invocations \
  -H 'content-type: application/json' \
  -d '{"prompt":"Quero comprar o Fone Bluetooth","usuario_id":"<sub>"}'
```

A resposta é SSE; o evento final traz `reply`, `purchase` e `intencao_id`.

Para continuar a conversa, envie `messages` no mesmo formato do frontend:

```json
{
  "messages": [
    { "role": "user", "content": [{ "type": "text", "text": "Quero comprar o Fone Bluetooth" }] },
    { "role": "assistant", "content": [{ "type": "text", "text": "Intenção INT-... pendente. Cartão ou pix?" }] },
    { "role": "user", "content": [{ "type": "text", "text": "Pix" }] }
  ],
  "usuario_id": "<sub>"
}
```

## Modo tools locais (mais rápido, sem DynamoDB)

Não defina os três ARNs. O agente usa:

- catálogo local (8 produtos);
- intenções em memória (perdem ao reiniciar);
- `LIMITE_COMPRA` (default 500) para o pagamento.

Bom para iterar prompt e formato de resposta; não valida persistência/IAM.

## Limitações

- Não exercita API Gateway, JWT, CORS nem a imagem Docker.
- Mudanças nas tools (Lambda) ainda exigem deploy; mudanças no `agent/` não.
- Usa Bedrock real (custo por chamada, baixo).
- O servidor sobe em `0.0.0.0:3031`; use apenas em rede confiável.
- AgentCore Runtime features (sessão, memória, guardrails) não estão no caminho local.

## Próximas fases (para acelerar mais)

1. **`agent/core.ts` + `agent/dev-call.ts`**: separar a criação do agente do servidor e
   chamar `createAgent` direto, sem HTTP/SSE. `npm run dev:call -- "prompt"`.
2. **Cenários**: catálogo, primeira compra, segunda compra após confirmada, limite
   excedido, Pix/cartão, com asserções no DynamoDB.
3. **Override no `api/index.ts`**: `LOCAL_AGENT=1` faz a Lambda chamar
   `http://localhost:3031/invocations` em vez do AgentCore Runtime; assim o navegador
   inteiro roda contra o agente local (ainda com JWT/CORS reais).
4. **Tools locais**: executar os handlers das tools com `tsx` para iterar tool + prompt
   sem deploy.

## Segurança

- O agente local só chama o que as credenciais permitem; use o perfil SSO.
- Não exponha a porta 3031 em rede pública.
- ARN do runtime, modelo e ARNs das tools não vão para o frontend.