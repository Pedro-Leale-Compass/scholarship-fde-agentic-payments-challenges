# Testes — Desafio 1 (luiz-henrique)

Suíte Node e fluxo local verificados em **2026-11-17**.

Quatro frentes:

1. **Fluxo local** (`npm run test:local`) — agente local + fallback ou Lambdas, sem API.
2. **Suíte Node** (`npm run test:agent`) — integração real com API/Cognito/DynamoDB.
3. **WebSocket smoke** (`npm run test:ws`) — parcial; `$connect` autentica, `$default` ainda falha.
4. **Coleção Postman** — quebrada; precisa de correção antes de ser usada.

A estratégia da suíte ampla (100+ casos) e o caso `REFUSAL-LOOP-01` estão em
[`docs/TEST-STRATEGY.md`](../docs/TEST-STRATEGY.md).

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
| `agente não confirma compra enquanto a intenção está pendente` | intenção pendente não é narrada como paga; o agente informa o ID; pagamento vira `paga` e debita saldo; compra acima do limite não é narrada como aprovada; segunda compra após uma compra paga funciona; `GET /conversas` devolve o histórico e exige JWT |

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

> **Em manutenção:** a coleção está quebrada e precisa de correção. As evidências da §6 do
> `README.md` foram produzidas com curl e com a suíte Node, e não dependem desta coleção.

Atualizada em **2026-11-17** para o deploy atual (`gn217i7svh`, pool
`us-east-1_MsflknLt3`).

Arquivos:

| Arquivo | Descrição |
|---|---|
| `postman-collection.json` | login Cognito, `POST /chat` com e sem token e as 5 evidências |
| `postman-environment.json` | variáveis locais (gitignorado; contém credenciais) |

### 3.1 Ordem das evidências

Execute na ordem; as pastas 3, 4 e 5 dependem do `idToken` salvo no login e usam
`conversa_id` próprios para não misturar intenções.

| Pasta | O que comprova | Observação |
|---|---|---|
| 1. Login Cognito | login e `IdToken` | salva `idToken` para as próximas requisições |
| 2. API sem token → 401 | rejeição pelo API Gateway | espera `401` |
| 3. Compra aprovada com Pix | Fone Bluetooth (R$ 199,90) pago no Pix | 3.1 registra, 3.2 paga |
| 4. Compra aprovada com cartão | Mouse Gamer (R$ 129,90) pago no cartão | 4.1 registra, 4.2 paga |
| 5. Limite excedido | Cadeira Gamer (R$ 1.499,00) recusada | 5.1 registra, 5.2 tenta pagar |
| 6. `intencao_id` inválido | `int_1234` recusado com `INTENCAO_INVALIDA` | invoca a Lambda `realizar_compra` diretamente |

O saldo precisa ser **R$ 500** para o roteiro fechar (199,90 + 129,90 ainda cabem;
1.499,00 não). Antes de rodar:

```bash
cd Desafio-1/luiz-henrique
eval "$(bash scripts/aws-creds.sh)"
npm run user:reset-limit -- luiz@desafio.test
```

Se o usuário de teste ainda não existir no pool atual, crie-o com
`npm run user:invite -- luiz@desafio.test 500`.

### 3.2 Teste de `intencao_id` inválido

O modelo se recusa a encaminhar um ID inexistente, então a recusa é comprovada
invocando a Lambda `realizar_compra` diretamente. A requisição usa **AWS Signature
v4** (serviço `lambda`); preencha no ambiente do Postman:

- `awsAccessKeyId`
- `awsSecretAccessKey`
- `awsSessionToken`

Obtenha os três valores da sessão SSO e copie para o ambiente:

```bash
aws sso login --profile desafio-1
eval "$(bash scripts/aws-creds.sh)"
env | grep '^AWS_'       # copie ACCESS_KEY_ID, SECRET_ACCESS_KEY e SESSION_TOKEN
```

A resposta esperada é HTTP `200` na invocação e, no corpo, `statusCode: 404` com
`code: INTENCAO_INVALIDA`.

### 3.3 Como usar

1. Importe `postman-collection.json` e `postman-environment.json`.
2. Selecione o ambiente `Desafio 1 - Ambiente (luiz-henrique)`.
3. Confira `testEmail`, `testPassword`, `apiUrl`, `userPoolClientId` e `region`;
   o arquivo local já aponta para o deploy atual. `apiUrl` fica **sem barra final**.
4. Rode na ordem das pastas (Collection Runner ou manualmente).
5. Para os prints, capture a resposta de cada pasta; o caso 6 mostra o corpo da
   Lambda com a recusa.
6. Para a evidência de login, prefira a tela do Cognito em
   `docs/apresentacao/01-login.png` ou redija o `IdToken` antes de capturar. Nunca
   publique o token, a senha ou as credenciais AWS.

`postman-environment.json` é gitignorado. Não commite credenciais nem o `idToken`.

## 4. Pré-requisitos e atualização

- `infra/cdk-outputs.json` gerado por `npm run deploy:api-agent`.
- Usuário de teste no Cognito (via `.env`/script ou console).
- Após redeploy, atualize `userPoolClientId`, `apiUrl` e `cognitoUserPoolId` no
  ambiente do Postman a partir de `infra/cdk-outputs.json`; as credenciais AWS do
  caso 6 expiram com a sessão SSO.
