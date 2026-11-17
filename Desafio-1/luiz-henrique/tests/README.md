# Testes — Desafio 1 (luiz-henrique)

Verificado em **2026-11-17**.

Três frentes:

1. **Fluxo local** (`npm run test:local`) — agente local + fallback ou Lambdas, sem API.
2. **Suíte Node** (`npm run test:agent`) — integração real com API/Cognito/DynamoDB.
3. **Coleção Postman** — login Cognito e testes manuais do `/chat`.

## 1. Fluxo local

```bash
npm run test:local
USE_REAL_TOOLS=1 npm run test:local   # usa Lambdas/DynamoDB reais
```

Sobe o agente em `:3031`, executa `monitor → cartão → LIMITE_EXCEDIDO/cancelada → fone →
pix` e falha se o ID antigo reaparecer. Por padrão usa o fallback em memória; consome
Bedrock (Haiku) em 4 chamadas curtas. É o teste de regressão mais rápido.

## 2. Suíte Node

```bash
cd Desafio-1/luiz-henrique
npm run test:agent
```

Requisitos:

- stack implantada (`infra/cdk-outputs.json`);
- credenciais AWS válidas (`aws sso login --profile desafio-1`);
- perfil `desafio-1` (ou `AWS_PROFILE`).

O teste cria usuário temporário no Cognito e itens no DynamoDB e remove ao final. Ele
**não** usa apenas o texto do modelo: confere status das intenções, saldo e códigos de erro
no backend.

### Cobertura atual

| Teste | O que valida |
|---|---|
| `POST /chat sem token` | resposta `401` do API Gateway |
| `realizar_compra: saldo, idempotência e códigos` | `COMPRA_APROVADA`, débito do saldo, retry `INTENCAO_JA_PAGA`, `LIMITE_EXCEDIDO`, `INTENCAO_INVALIDA` (inexistente e dono errado), `INTENCAO_EXPIRADA`, `METODO_INVALIDO` |
| `agente não confirma compra enquanto a intenção está pendente` | intenção pendente não é narrada como paga; o agente informa o ID; pagamento vira `paga` e debita saldo; compra acima do limite não é narrada como aprovada; segunda compra após uma compra paga funciona |

### Cobertura de regressão

A suíte agora inclui, após `LIMITE_EXCEDIDO`, um novo produto e verifica que ele cria um
**novo** ID e paga. O fluxo local também cobre esse cenário.

Lacunas:

- duas conversas (`conversa_id`) devem ser isoladas;
- duas abas na mesma conversa;
- chamadas de tool em paralelo.

Adicionar esses casos faz parte da Fase 5 do
[`docs/PLAN-AGENT-REVAMP.md`](../docs/PLAN-AGENT-REVAMP.md).

### Observações

- A variável de tabela foi corrigida de `INTOCOES_TABLE` para `INTENCOES_TABLE`. O default
  continua `luiz-henrique-intencoes`.
- O teste usa `aws` CLI e `fetch`; não precisa de Postman.
- Custo: cria/deleta itens DynamoDB e faz chamadas Bedrock reais. Rode com moderação.

## 3. Coleção Postman

Arquivos:

| Arquivo | Descrição |
|---|---|
| `postman-collection.json` | login Cognito + `POST /chat` com e sem token |
| `postman-environment.json` | variáveis locais (gitignorado; contém credenciais) |

Fluxo:

1. `InitiateAuth` (`USER_PASSWORD_AUTH`) com `testEmail`/`testPassword`; salva `idToken`.
2. `POST /chat` com `Authorization: Bearer {{idToken}}`; espera 200 com `reply`/`message`.
3. `POST /chat` sem token; espera `401`.

Como usar:

1. Importe os dois JSONs no Postman.
2. Selecione o ambiente do projeto.
3. Preencha `testEmail`, `testPassword`, `userPoolClientId`, `apiUrl` e `region`.
4. Execute na ordem: login → chat com token → chat sem token.

`postman-environment.json` é gitignorado. Não commite credenciais.

## 4. Pré-requisitos e atualização

- `infra/cdk-outputs.json` gerado por `npm run deploy:api-agent`.
- Usuário de teste no Cognito (via `.env`/script ou console).
- Após redeploy, atualize `userPoolClientId`/`apiUrl` no ambiente do Postman.
