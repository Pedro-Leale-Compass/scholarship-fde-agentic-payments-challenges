# Infraestrutura do desafio

Este pacote define a infraestrutura AWS com CDK em TypeScript para o backend
e a autenticação Cognito. O frontend roda localmente em
`http://localhost:3000`; a stack não cria recursos de hospedagem para ele. A
stack está configurada para `us-east-1`. O código e a síntese da stack não
autorizam o deploy: não publique recursos até receber autorização expressa.

## Arquitetura e estado

- Cinco tabelas DynamoDB para produtos, usuários, conversas, intenções e
  transações.
- User Pool do Cognito sem auto cadastro, com login por e-mail e recuperação
  por e-mail. A criação de usuários deve ser administrativa.
- App client público para o frontend, com autenticação SRP e sem OAuth nem
  segredo. O cadastro é administrativo; usuários são provisionados pela
  coordenação.
- REST API com authorizer Cognito e streaming de resposta habilitado na rota
  `POST /chat`. O CORS da rota e das respostas `401`/`403` permite somente
  `http://localhost:3000`.
- O handler da API fica em `../api/chat.ts`; o código Strands fica em
  `../agent/`. Esta pasta contém apenas a infraestrutura CDK.
- O pacote `../api/` contém as dependências do handler; `npm run build:api`
  instala as dependências antes dos testes, síntese ou deploy.
- O frontend local lê `UserPoolId`, `UserPoolClientId` e `ChatApiEndpoint` de
  `../frontend/.env.local`; consulte o
  [`README do frontend`](../frontend/README.md) para configurá-lo.
- A Lambda de chat obtém o `sub` exclusivamente do authorizer Cognito, garante
  de forma idempotente o perfil do usuário em `AlanLorenz-Usuarios` no primeiro
  acesso autenticado (limite inicial de R$ 1.000,00 / 100000 centavos), invoca o
  AgentCore com um identificador de sessão derivado do usuário e da conversa e
  converte os eventos SSE do runtime em NDJSON para o cliente. Ela grava a nova
  mensagem do usuário antes da invocação e, ao final, persiste a resposta do
  agente e os eventos das ferramentas.
- O runtime é um CodeZip Python 3.13, gerenciado pelo CDK, com Strands e o
  modelo `us.anthropic.claude-haiku-4-5-20251001-v1:0`.
- O agente usa o prompt de negócio original, mantém o histórico enviado pelo
  cliente (inclusive resultados de tools) e expõe as mesmas três tools:
  `listar_catalogo`, `registrar_intencao` e `realizar_compra`.
- As tools são Lambdas TypeScript e recebem o `sub` do Cognito e o UUID da
  conversa em `authenticatedContext`, separado dos argumentos do modelo.
- A compra usa uma única transação DynamoDB condicional para marcar a intenção
  como paga, debitar o limite restante, atualizar o estoque e gravar a
  transação. A chave da transação é a intenção, impedindo pagamento duplicado.
- Cada Lambda tem grupo de logs com retenção de uma semana e papel separado,
  com permissões DynamoDB limitadas às tabelas e operações necessárias. O
  runtime invoca somente as três Lambdas e o perfil/modelo Bedrock
  configurados e mantém somente os grants de logs/identidade necessários à
  execução.
- Somente a role da Lambda do chat tem `dynamodb:PutItem` na tabela de
  conversas; ela também possui `dynamodb:GetItem`/`dynamodb:PutItem` em
  `AlanLorenz-Usuarios` para provisionar o perfil no primeiro acesso
  autenticado. As Lambdas das ferramentas não recebem o nome nem permissão para
  acessar a tabela de conversas; os eventos de ferramenta retornam pelo
  AgentCore e são gravados pelo handler do chat.
- Os grants globais `Resource: "*"` de X-Ray/métricas do construct AgentCore
  foram removidos (tracing e métricas customizadas não são usados). O teste
  CDK verifica que nenhuma policy tenha `Resource: "*"`.

O prompt de negócio está em
`../frontend/src/lib/chat/payload.ts`; sua cópia server-side no runtime não
confia em um prompt `system` fornecido pelo cliente. Os invariantes de limite,
validade, propriedade, saldo, estoque e pagamento único continuam verificados
pelas tools, não pelo modelo.

## Modelo de dados DynamoDB

| Tabela | Chave de partição | Chave de ordenação | Uso |
|---|---|---|---|
| `AlanLorenz-Produtos` | `id` | — | Catálogo, preço em centavos e estoque |
| `AlanLorenz-Usuarios` | `userId` | — | `sub` do Cognito e limite restante em centavos |
| `AlanLorenz-Conversas` | `userId` | `messageKey` | Mensagens e eventos de ferramenta por conversa; chave `<conversaId>#<turno>#<ordem>` |
| `AlanLorenz-Intencoes` | `intentionId` | — | Proprietário, conversa, total calculado, status e expiração |
| `AlanLorenz-Transacoes` | `intentionId` | — | Uma transação por intenção; `transactionId` fica como atributo do item |

As tabelas usam cobrança sob demanda com limite de throughput configurado para
5 unidades de leitura e escrita por segundo. Esse limite reduz picos de
throughput, mas **não é um teto de gasto mensal**. Não foram habilitados TTL
nem índices secundários: intenções expiradas precisam continuar disponíveis
para que a ferramenta possa responder `INTENCAO_EXPIRADA`, e os índices
adicionariam custo sem serem necessários para os acessos atuais.

O perfil de um usuário Cognito é criado no primeiro acesso autenticado ao chat,
com o limite inicial de R$ 1.000,00 (`100000` centavos). As ferramentas também
garantem a criação idempotente do perfil se necessário. O catálogo inicial é o
mesmo do chatbot da Fase 1; não são migrados usuários, conversas ou compras do
SQLite.

## Contrato de `POST /chat`

A chamada usa o access/ID token Cognito como `Authorization: Bearer ...` e um
corpo no formato:

```json
{
  "conversaId": "c3ad9981-cd4c-4a01-9a7a-f7248173ad19",
  "messages": [
    { "role": "user", "content": "Quais produtos estão disponíveis?" }
  ]
}
```

O ID da conversa deve ser UUID v4. A Lambda não aceita identidade do cliente
no corpo: o usuário é sempre o `sub` extraído dos claims validados pelo Cognito.
O histórico completo, incluindo mensagens de tools, é transmitido ao Strands;
mensagens `system` vindas do cliente são ignoradas e substituídas pelo prompt
server-side. O runtime devolve eventos SSE, que a Lambda converte em linhas
NDJSON (`message`, `tool`, `error` e `done`).

A persistência grava apenas a nova mensagem do usuário, a resposta produzida e
os eventos das ferramentas do turno, sem regravar o histórico completo recebido
do frontend. A chave determinística por conversa e turno torna os `PutItem`
idempotentes em retentativas. Os itens ficam sob a partição do `sub` validado;
a role do chat tem apenas escrita na tabela, sem leitura.

O API Gateway REST foi escolhido para preservar a resposta incremental: o
streaming de resposta não é suportado por HTTP API. O endpoint permanece
protegido por Cognito. Não se usa o cabeçalho AgentCore `Runtime-User-Id`; o
identificador de sessão é calculado no backend a partir de `sub` e conversa.

## Validar e publicar

Requisitos: Node.js/npm, Python 3.13 e `uv`. A partir desta pasta:

```powershell
npm ci
npm run test -- --runInBand
npm run test:agent
npm run synth
```

A síntese não invoca o Claude, não acessa dados AWS nem faz deploy. Para
validar o frontend localmente, execute `npm ci` e `npm run check` em
`../frontend/`; para validar as ferramentas TypeScript, execute `npm run check`
em `../tools/`.

Depois de revisar a síntese, configurar credenciais AWS com permissão para
criar os recursos e obter autorização expressa, o deploy completo é:

```powershell
npm run deploy
```

Esse comando constrói o backend e o agente, prepara o ambiente de bootstrap
do CDK em `us-east-1` se necessário e executa `cdk deploy`. Ele implanta o
backend e o Cognito, mas não constrói nem publica o frontend. Bootstrap e
deploy alteram a conta AWS: não execute sem autorização. Também não execute o
seed do catálogo ou uma chamada ao Haiku sem autorização expressa.

Depois de um deploy autorizado, o catálogo pode ser inserido sem sobrescrever
estoque existente. Na pasta `../tools/`, configure `PRODUCTS_TABLE` com o nome
`AlanLorenz-Produtos` e execute `npm run seed:catalog`. Esse comando grava no
DynamoDB; não o execute como parte dos testes locais.

Não execute `cdk deploy`, o seed de catálogo ou uma chamada ao Haiku sem
autorização expressa. A primeira chamada ao modelo pode registrar a inscrição
na conta, e o limite de crédito informado é US$ 20. O build e a síntese locais
não publicam recursos AWS.
