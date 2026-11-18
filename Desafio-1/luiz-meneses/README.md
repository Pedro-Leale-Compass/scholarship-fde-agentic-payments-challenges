# ChatPay na AWS — Desafio 1 (Luiz Felipe Meneses)

Migração do ChatPay (chatbot de compras simuladas da Fase 1: FastAPI + SQLite + Ollama + MCP) para a AWS.
O agente agora é **Strands** rodando no **Bedrock AgentCore Runtime** com **Claude Haiku 4.5**, as três tools rodam em **Lambda**,
o estado fica no **DynamoDB**, o login é do **Cognito** (só por convite) e tudo é criado por **AWS CDK** com um comando.

As regras de negócio da Fase 1 não mudaram: catálogo, intenção de compra válida por 10 minutos, pagamento com Pix ou cartão,
limite por usuário e validação da intenção.

## Arquitetura implementada

```
Front React (local, Vite)                 login com Cognito (Authenticator do Amplify, sem cadastro)
   │  HTTPS + Authorization: Bearer <ID token do Cognito>
   ▼
API Gateway REST  (autorizador Cognito → 401 sem token válido; throttling 5 req/s)
   ├─ POST /chat       → Lambda chat (Node 22, resposta em STREAMING)
   └─ GET  /conversas  → Lambda conversas (Node 22)
                          │ usuario_id = claim "sub" do token
                          ▼
        Agente Strands no Bedrock AgentCore Runtime (container ARM64) ──► Bedrock: Claude Haiku 4.5
                          │ tools com usuario_id preso no backend
                          ▼
        Lambda tools (Python 3.12): listar_catalogo · registrar_intencao · realizar_compra
                          ▼
        DynamoDB: usuarios · catalogo · intencoes · transacoes      (conversas: só a Lambda do chat)
```

### Adaptações em relação à arquitetura de referência (e por quê)

| Referência | O que foi feito | Motivo |
|---|---|---|
| Front em S3 + CloudFront | Front **roda local** (`npm run dev`) | Orientação do instrutor no Teams em 2026-11-16: o CloudFront está com problema de permissão na conta; backend e autenticação ficam na AWS. |
| HTTP API com JWT authorizer | **REST API** com autorizador Cognito User Pools | O desafio pede streaming; o streaming de resposta da Lambda pelo API Gateway existe na REST API (`responseTransferMode: STREAM`), não na HTTP API. O autorizador continua validando o JWT do Cognito e respondendo 401. |
| Lambda do chat (linguagem livre) | Lambda do chat em **Node.js** | Streaming de resposta nativo do Lambda (`awslambda.streamifyResponse`) só existe no runtime Node. Tools e agente seguem em Python. |
| Uma Lambda por tool | **Uma Lambda com roteamento interno** | Permitido pelo enunciado; as três tools usam as mesmas tabelas. |

## Pré-requisitos

- Conta do desafio com login SSO configurado (perfil apontando para `us-east-1`) — ver `login sso.md` na raiz do repositório.
- Acesso ao Claude Haiku 4.5 liberado no Bedrock (teste de "pong" abaixo).
- Node.js 20+ e npm; Docker Desktop **rodando** (o CDK constrói a imagem ARM64 do agente).
- CDK bootstrap na conta/região (uma vez por conta): `npx cdk bootstrap aws://<conta>/us-east-1`.

```bash
aws sso login
aws sts get-caller-identity
aws bedrock-runtime converse --region us-east-1 \
  --model-id us.anthropic.claude-haiku-4-5-20251001-v1:0 \
  --messages '[{"role":"user","content":[{"text":"Reply with exactly: pong"}]}]' \
  --query 'output.message.content[0].text' --output text
```

## Deploy (um comando)

```bash
cd Desafio-1/luiz-meneses/api && npm ci && cd ../infra && npm ci
npm run deploy
```

`npm run deploy` roda `cdk deploy` da stack `luiz-meneses-desafio1` (tabelas, carga do catálogo, Cognito, Lambdas, imagem e runtime
do AgentCore, API Gateway, roles) e depois gera `frontend/.env.local` com a URL da API e os IDs do Cognito, a partir das saídas
do deploy. Nenhum desses valores fica fixo no código.

### Criar usuários (cadastro só por convite)

```bash
aws cognito-idp admin-create-user --region us-east-1 \
  --user-pool-id <UserPoolId> --username email@exemplo.com \
  --user-attributes Name=email,Value=email@exemplo.com Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL
```

O Cognito envia o convite com senha temporária; no primeiro login o usuário define a senha nova.

### Rodar o front

```bash
cd Desafio-1/luiz-meneses/frontend
npm ci
npm run dev        # http://localhost:5173 (única origem aceita no CORS da API)
```

Valores da implantação atual (não são segredos; servem para rodar o front sem fazer deploy). Copie para
`frontend/.env.local`:

```
VITE_API_URL=https://w6ilv2h9fl.execute-api.us-east-1.amazonaws.com/prod
VITE_USER_POOL_ID=us-east-1_9EOCxvoin
VITE_USER_POOL_CLIENT_ID=5om1s9h8u2s2cjvih9re577rhm
VITE_REGION=us-east-1
```

## Modelo do Bedrock

`us.anthropic.claude-haiku-4-5-20251001-v1:0` (Claude Haiku 4.5, perfil de inferência dos EUA), o recomendado pelo desafio:
baixo custo, boa latência e bom tool calling. Temperatura 0,2 para respostas mais previsíveis em fluxo de compra.

## Modelagem do DynamoDB

Todas as tabelas em modo sob demanda, com o prefixo `luiz-meneses-`.

| Tabela | Chave | O que guarda | Quem acessa |
|---|---|---|---|
| `usuarios` | `usuario_id` (sub do Cognito) | `limite_centavos` (padrão R$ 2.000), `gasto_centavos`; criado no primeiro uso | tools |
| `catalogo` | `produto_id` | nome, categoria, `preco_centavos`, moeda, estoque (carregado no deploy) | tools |
| `intencoes` | `intencao_id` | dono, produto, quantidade, `valor_total_centavos`, status (`pendente`/`paga`), `expira_em` | tools |
| `transacoes` | `transacao_id` | intenção, dono, valor, método, data | tools |
| `conversas` | `usuario_id` + `ordem` (data do turno + posição) | cada mensagem no formato do Strands (texto, chamada e resultado de tool) | Lambda do chat |

**Sem cobrança duplicada:** `realizar_compra` grava tudo numa única `TransactWriteItems` com condições — intenção
`pendente → paga` (e do mesmo usuário, e não expirada), `gasto + valor <= limite`, `estoque >= quantidade` e transação
`attribute_not_exists`. Se a mesma chamada chegar duas vezes, só a primeira passa; a segunda recebe `INTENCAO_JA_PAGA`.

## Regras de segurança

- `usuario_id` sai do claim `sub` do token validado pelo API Gateway e é passado ao agente pelo backend; as tools são criadas
  por requisição com o usuário preso nelas, então o modelo nem vê esse parâmetro.
- O valor da compra é o `valor_total_centavos` gravado na intenção; `realizar_compra` só recebe `intencao_id` e método.
- Erros da Fase 1 mantidos: `INTENCAO_INVALIDA` (inexistente ou de outro usuário), `INTENCAO_EXPIRADA`, `INTENCAO_JA_PAGA`,
  `LIMITE_EXCEDIDO`, `METODO_INVALIDO` (este foi acrescentado; na Fase 1 o método era validado só pelo tipo).
- Proteções que vieram do backend da Fase 1: o pagamento só roda se a **mensagem atual** do usuário confirmar Pix ou cartão,
  e se o modelo escrever "compra aprovada" sem `realizar_compra` ter aprovado, a resposta recebe um aviso.
- Falhas viram mensagens legíveis para o usuário; detalhes ficam só no CloudWatch.
- O ID da sessão do AgentCore inclui a versão do runtime: depois de um deploy, a conversa abre sessão nova e não fica
  presa ao container da versão anterior. O histórico não depende da sessão: vem do DynamoDB a cada turno.

## Permissões (IAM)

| Role | Pode | Não pode |
|---|---|---|
| Lambda chat | `bedrock-agentcore:InvokeAgentRuntime` no runtime do agente; ler/gravar `conversas`; logs | Bedrock, tabelas de compra |
| Lambda conversas | ler `conversas`; logs | o resto |
| Runtime do AgentCore | `bedrock:InvokeModel*` só no Haiku 4.5 (modelo base + perfil `us.`); `lambda:InvokeFunction` só na Lambda de tools; logs; puxar a própria imagem do ECR | qualquer tabela |
| Lambda tools | ler/gravar `usuarios`, `catalogo`, `intencoes`; gravar `transacoes`; logs | `conversas`, Bedrock |

Sem `"Action": "*"` e sem `AdministratorAccess`. As únicas linhas com `Resource: "*"` são as que a AWS exige no papel padrão
do AgentCore (`ecr:GetAuthorizationToken`, `xray:Put*`, `cloudwatch:PutMetricData` com condição de namespace), que não aceitam
recurso específico. O API Gateway não altera a role de logs da conta (`cloudWatchRole: false`), porque a conta é compartilhada.

## Testes

```bash
cd tools && pip install boto3 "moto[dynamodb]" pytest && pytest -q
```

Cobrem compra com Pix e cartão, cobrança duplicada, limite excedido, intenção inexistente e de outro usuário, intenção
expirada, método inválido e tentativa de passar `usuario_id` pelos argumentos.

## Evidências

Capturadas em 2026-11-18 contra a stack implantada (front local apontando para a API na AWS).

| # | Cenário | Arquivo |
|---|---|---|
| 1 | Login com Cognito, sem opção de cadastro | [01-login-sem-cadastro.png](evidencias/01-login-sem-cadastro.png) |
| 2 | Usuário logado consultando o catálogo (tool `listar_catalogo`) | [02-catalogo-logado.png](evidencias/02-catalogo-logado.png) |
| 3 | Compra aprovada com **Pix** | [03-compra-pix.png](evidencias/03-compra-pix.png) |
| 4 | Compra aprovada com **cartão** | [04-compra-cartao.png](evidencias/04-compra-cartao.png) |
| 5 | Notebook (R$ 4.599,90) acima do limite de R$ 2.000 → `LIMITE_EXCEDIDO` | [05-limite-excedido.png](evidencias/05-limite-excedido.png) |
| 6 | `intencao_id` inexistente → `INTENCAO_INVALIDA` (recusado pela Lambda, não pelo modelo) | [06-intencao-invalida.png](evidencias/06-intencao-invalida.png) |
| 7 | `POST /chat` sem token e com token falso → `401` do API Gateway | [07-api-401-sem-token.txt](evidencias/07-api-401-sem-token.txt) |

Também conferido: `aws cognito-idp sign-up` direto na API do Cognito é recusado com
`NotAuthorizedException: SignUp is not permitted for this user pool`.

## Remoção

```bash
cd Desafio-1/luiz-meneses/infra
npm run destroy
```

Tabelas, user pool e log groups têm `RemovalPolicy.DESTROY` e saem com a stack. Depois, conferir no console (us-east-1) que não
restou: runtime do AgentCore, repositório/imagens do ECR de assets do CDK, tabelas `luiz-meneses-*`, user pool e log groups
`/aws/lambda/luiz-meneses-*` e `/aws/bedrock-agentcore/runtimes/*` (este último é criado pelo próprio AgentCore, fora da stack).
