# Operações — deploy, modelo, logs e custos

Verificado em **2026-11-17**. Região `us-east-1`; conta com orçamento de **US$ 20** e
aproximadamente **US$ 5** gastos no momento desta revisão.

## 1. Credenciais

O perfil do projeto é `desafio-1` (AWS IAM Identity Center / `login_session`).

```bash
aws sso login --profile desafio-1
cd Desafio-1/luiz-henrique
eval "$(scripts/aws-creds.sh)"
```

`scripts/aws-creds.sh` converte a sessão em `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/
`AWS_SESSION_TOKEN`, que o CDK e os SDKs JavaScript usam.

## 2. Deploy

```bash
npm run synth          # opcional: gera o template
npm run diff           # revise antes de aplicar
npm run deploy:api-agent
```

O deploy cria/atualiza: DynamoDB, tools, agente (imagem ECR + AgentCore Runtime), API
Gateway, Cognito e seed do catálogo. **Não** cria frontend, S3, CloudFront, VPC ou NAT.

Cuidados de custo:

- `cdk diff` deve mostrar apenas mudanças esperadas. Se aparecer CloudFront, NAT Gateway,
  VPC, Amplify Hosting ou outro serviço novo, pare e revise.
- A imagem do agente é publicada no ECR pelo CDK; versões antigas podem acumular. O destroy
  remove o repositório da stack, mas confira `npm run check:logs`/console.
- Cada deploy atualiza o AgentCore Runtime; não é necessário recriar o runtime.

## 3. Confirmar o modelo (sem custo de Bedrock)

```bash
npm run check:model
```

O script lê `infra/cdk-outputs.json`, chama
`bedrock-agentcore-control get-agent-runtime` e imprime:

- status e versão do runtime;
- `environmentVariables.BEDROCK_MODEL_ID`;
- se o valor é Claude Haiku 4.5 ou o fallback Nova 2 Lite.

Isso é leitura de control plane: **não invoca o modelo**. Se o `.env` não existir no
momento do deploy, o CDK usa `global.amazon.nova-2-lite-v1:0` silenciosamente. O
`infra/cdk.out/Desafio1Stack.template.json` reflete o último `synth`, não o runtime vivo.

**Verificado em 2026-11-17:** runtime `luiz_henrique_agent-AD3mRGF7e9`, versão 15, status
`READY`, `BEDROCK_MODEL_ID=us.anthropic.claude-haiku-4-5-20251001-v1:0`.

## 4. Logs no CloudWatch

```bash
npm run check:logs
```

O script lista, somente leitura:

- `/aws/bedrock-agentcore/*` (runtime);
- `/aws/lambda/luiz-henrique-*` (tools e chat).

Para cada grupo, mostra os streams mais recentes e os últimos eventos de 24h.

Observações:

- A role do runtime inclui `AWSLambdaBasicExecutionRole`; na prática, o serviço grava no
  grupo `/aws/bedrock-agentcore/runtimes/<id>-DEFAULT` abaixo. O console do AgentCore pode
  não exibir o link.
- **Confirmado em 2026-11-17:** o runtime atual escreve em
  `/aws/bedrock-agentcore/runtimes/luiz_henrique_agent-AD3mRGF7e9-DEFAULT`. O console do
  AgentCore pode não exibir o link; abra o grupo direto no CloudWatch Logs. O ID do
  runtime (e do grupo) muda se o runtime for recriado; use `npm run check:model` para obter
  o ID atual.
- As Lambdas escrevem em `/aws/lambda/luiz-henrique-chat`,
  `/aws/lambda/luiz-henrique-listar-catalogo`, `/aws/lambda/luiz-henrique-registrar-intencao`
  e `/aws/lambda/luiz-henrique-realizar-compra`.
- Se `check:logs` não encontrar `/aws/bedrock-agentcore/*`, confirme o ID do runtime com
  `npm run check:model` e procure o sufixo `-DEFAULT`. Não crie um log group manualmente
  antes de confirmar; logs têm free tier de 5 GB, mas evite retenção infinita.
- Os logs do agente incluem eventos `guard: fabricated_turn_removed`,
  `guard: registration_reply_adjusted`, `guard: registration_fallback`,
  `guard: purchase_reply_adjusted` e `guard: payment_fallback_verified`. Use-os para confirmar o comportamento descrito no
  `PLAN-AGENT-REVAMP.md`. Para filtrar só esses eventos:

```bash
aws logs filter-log-events \
  --log-group-name /aws/bedrock-agentcore/runtimes/luiz_henrique_agent-AD3mRGF7e9-DEFAULT \
  --filter-pattern guard \
  --region us-east-1 --profile desafio-1 \
  --query 'events[].message' --output text | tail -40
```
- Os logs das Lambdas mostram `tool: registrar_intencao`/`realizar_compra` com o
  `intencao_id`. É a forma mais rápida de provar se a tool foi chamada em um turno.

## 5. Testes

```bash
npm run test:local   # agente local + fallback (Haiku), sem DynamoDB/Lambda
npm run test:agent   # integração na stack implantada
npm run test:ws      # WebSocket parcial (connect/auth; $default falha)
```

Requer stack implantada e credenciais. Cria usuário temporário no Cognito/DynamoDB e limpa
ao final. Cobertura atual e lacunas: `tests/README.md`.

Para iterar prompt sem DynamoDB/Lambda:

```bash
npm run dev:agent   # ver docs/DEV-LOCAL-AGENTE.md
```

## 6. Destruir

```bash
npm run destroy
```

O comando roda `cdk destroy --force` e depois `scripts/destroy-cleanup.sh`. O script remove
órfãos conhecidos: log groups, roles IAM, recursos de API Gateway e versões `$LATEST`.
Detalhes e verificação: `destroy-cleanup.md`.

Nunca rode destroy com recursos de outros fellows na mesma conta sem revisar os filtros por
prefixo `luiz-henrique`/`Desafio1Stack`.

## 7. Troubleshooting

| Sintoma | O que verificar |
|---|---|
| `NoCredentials` | `aws sso login --profile desafio-1` e `eval "$(scripts/aws-creds.sh)"` |
| Runtime não atualiza | `npm run check:model`; veja `AgentRuntimeVersion`/`lastUpdatedAt` |
| Modelo errado (Nova em vez de Haiku) | `.env` com `BEDROCK_MODEL_ID` e redeploy; confirme com `check:model` |
| Nenhum log do runtime | `check:logs`; confirme o grupo `/aws/bedrock-agentcore/*` |
| Compra paga duas vezes | `Intencoes.status` e logs de `realizar_compra`; a transação só aceita `pendente` |
| `INTENCAO_JA_PAGA` em intenção cancelada | não deve mais ocorrer; confirme se o deploy tem a versão com `INTENCAO_CANCELADA` |
| Custo subindo | `check:logs`/Bedrock usage; evite testes repetidos; use fallback local |
| WebSocket `Internal server error` | `WS-NEXT.md`: permissão `$default`/`$disconnect` e rota |
