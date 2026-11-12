# MiniStack — Ambiente de desenvolvimento local (Bedrock emulator + LLM)

MiniStack é um emulador AWS local, gratuito e open-source (60+ serviços, porta única `4566`, compatível com Terraform/CDK/SDKs). Substitui o LocalStack Community para desenvolvimento local.

Neste desafio, MiniStack é usado como **provedor LLM local para o Amazon Bedrock**: em vez de chamar a Bedrock real na AWS, as chamadas `Converse`/`InvokeModel` são proxyadas para um servidor de inferência local (llama.cpp com Qwen3.5 2B Q8) e retornam no formato de wire exato da Bedrock.

---

## Fluxo de dados (dev local)

```
Frontend (Next.js)
      │ HTTPS + JWT (Cognito)
      ▼
API Gateway  ──► Lambda do chat  ──► Agente Strands (AgentCore)  ──► Bedrock-Runtime
                                                      (ministerio local)      │
                                                                        ▼
                                                                  MiniStack :4566
                                                                        │
                                                                        ▼ MINISTACK_BEDROCK_PROXY_URL
                                                                  llama.cpp :8080 (rede Docker)
                                                                        │
                                                                        ▼
                                                                  Qwen3.5 2B Q8 (CUDA)
```

Camadas:

| Camada | Serviço | Porta host | Descrição |
|--------|---------|------------|-----------|
| LLM / inferência | llama.cpp (CUDA) | `1203` → contêiner `8080` | Qwen3.5 2B Q8, endpoint OpenAI-compatível `/v1/chat/completions` |
| Emulador AWS / Bedrock | MiniStack | `4566` | Bedrock-Runtime (Converse/InvokeModel), DynamoDB, S3, IAM, etc. com `LOG_LEVEL=DEBUG` |
| Proxy Bedrock → LLM | `MINISTACK_BEDROCK_PROXY_URL` | — | `http://llama-server:8080` (mesma rede Docker `dev-tools-network`) |

---

## Executar o ambiente local

```bash
cd Desafio-1/luiz-henrique/dev-tools

# Subir MiniStack + llama.cpp (Qwen3.5 2B Q8)
docker compose up -d

# Verificar saúde
curl http://localhost:4566/_ministack/health
curl http://localhost:1203/health

# Logs (DEBUG do MiniStack)
docker compose logs -f ministack

# Parar
docker compose down
```

### Variáveis de ambiente do MiniStack (`compose.yaml`)

| Variável | Valor | Finalidade |
|----------|-------|------------|
| `LOG_LEVEL` | `DEBUG` | Logs detalhados do MiniStack |
| `MINISTACK_REGION` | `us-east-1` | Região padrão do emulador |
| `MINISTACK_ACCOUNT_ID` | `000000000000` | ID da conta para ARNs |
| `MINISTACK_BEDROCK_PROXY_URL` | `http://llama-server:8080` | Proxy Bedrock → llama.cpp (completions reais) |
| `MINISTACK_BEDROCK_PROXY_TIMEOUT_SECONDS` | `30` | Timeout da chamada ao proxy |

---

## Endpoints locais do ambiente de desenvolvimento

| Endpoint | Descrição | Exemplo de uso |
|----------|-----------|----------------|
| `http://localhost:4566/_ministack/health` | Health check do MiniStack | `curl http://localhost:4566/_ministack/health` |
| `http://localhost:4566/_ministack/reset` | Reset de todo o estado (entre testes) | `curl -X POST http://localhost:4566/_ministack/reset` |
| `http://localhost:4566` | Bedrock-Runtime + todos os serviços AWS emulados | `boto3.client("bedrock-runtime", endpoint_url="http://localhost:4566", ...)` |
| `http://localhost:1203/v1/chat/completions` | llama.cpp OpenAI-compatível (direto) | `curl -X POST http://localhost:1203/v1/chat/completions ...` |
| `http://localhost:4566` (modelId=`qwen3.5`) | Bedrock Converse via proxy llama.cpp | `bedrock.converse(modelId="qwen3.5", ...)` |

---

## Testar o Bedrock emulator diretamente (boto3)

```python
import boto3, json

bedrock = boto3.client(
    "bedrock-runtime",
    endpoint_url="http://localhost:4566",
    aws_access_key_id="test",
    aws_secret_access_key="test",
    region_name="us-east-1",
)

resp = bedrock.converse(
    modelId="qwen3.5",
    messages=[{"role": "user", "content": [{"text": "Qual é a capital do Brasil?"}]}],
    inferenceConfig={"maxTokens": 100, "temperature": 0.7},
)
print(resp["output"]["message"]["content"][0]["text"])
```

Resultado esperado: HTTP 200 com corpo no formato de wire da Bedrock (`output.message`, `usage`, `stopReason`, `metrics`). MiniStack proxya a requisição para o llama-server e retorna uma completion real do Qwen3.5 (não o mock determinístico).

---

## Como o projeto usaria o MiniStack (API do desafio)

A pasta `api/` agora contém o Lambda do chat (`api/index.js`) com o switch de ambiente via `BEDROCK_ENDPOINT_URL`:

1. Frontend → `POST /chat` na API Gateway (autorizador JWT Cognito).
2. Lambda do chat (`chatFn`) recebe o token, extrai `usuario_id` do `sub` (nunca do corpo nem do modelo).
3. Lambda chama o Bedrock-Runtime (`Converse`) com as tools `listar_catalogo`, `registrar_intencao`, `realizar_compra`.
4. O `endpoint_url` do SDK vem de `BEDROCK_ENDPOINT_URL`:
   - Local: `http://localhost:4566` → MiniStack → llama.cpp/Qwen3.5
   - AWS: *(não definido)* → Bedrock real us-east-1 (Claude Haiku)

O CDK em `infra/lib/api-stack.ts` carrega o código de `api/` (`lambda.Code.fromAsset`) e injeta `BEDROCK_ENDPOINT_URL` como variável de ambiente do Lambda.


---

## Switch: dev local (MiniStack) vs deploy AWS real

A separação entre ambiente local e produção é feita pelo **AWS profile** (`~/.aws/config`), sem alterar código e sem exportar variáveis no terminal:

| Comando | Ambiente | Endpoint Bedrock do Lambda |
|---------|----------|----------------------------|
| `AWS_PROFILE=local cdk deploy` | Desenvolvimento local | `http://localhost:4566` (MiniStack → llama.cpp/Qwen3.5) |
| `AWS_PROFILE=desafio-1 cdk deploy` | Produção AWS real | *(sem endpoint)* → Bedrock real us-east-1 (Claude Haiku) |
| `BEDROCK_ENDPOINT_URL=<url> cdk deploy` | Sobrescreve manualmente | URL informada |

O profile `local` já existe em `~/.aws/config`:

```ini
[profile local]
region = us-east-1
```

### Como funciona no código (`api/index.js`)

```javascript
let bedrockEndpoint = process.env.BEDROCK_ENDPOINT_URL;
if (!bedrockEndpoint && process.env.AWS_PROFILE === "local") {
  bedrockEndpoint = "http://localhost:4566";
}

const bedrock = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || "us-east-1",
  ...(bedrockEndpoint
    ? { endpoint: bedrockEndpoint,
        credentials: { accessKeyId: "test", secretAccessKey: "test" } }
    : {}),
});
```

- `BEDROCK_ENDPOINT_URL` definido → usa esse endpoint (MiniStack local ou qualquer outro).
- Não definido + `AWS_PROFILE=local` → `http://localhost:4566` (MiniStack).
- Não definido + outro profile → endpoint real da AWS Bedrock.

### Pelo CDK (`infra/lib/api-stack.ts`)

O `chatFn` lê `process.env.AWS_PROFILE` e injeta `BEDROCK_ENDPOINT_URL` no Lambda:

```ts
const isLocalProfile = process.env.AWS_PROFILE === 'local';
const bedrockEndpoint = process.env.BEDROCK_ENDPOINT_URL || (isLocalProfile ? 'http://localhost:4566' : '');

environment: {
  BEDROCK_ENDPOINT_URL: bedrockEndpoint,
  ...
},
```

### Exemplos de uso

```bash
# Desenvolvimento local contra o MiniStack (roda em :4566)
AWS_PROFILE=local cdk deploy --require-approval never

# Deploy na AWS real (Bedrock Claude Haiku)
AWS_PROFILE=desafio-1 cdk deploy --require-approval never

# Forçar endpoint específico (ignora o profile)
BEDROCK_ENDPOINT_URL=http://localhost:4566 cdk deploy --require-approval never
```

### Build do Lambda (TypeScript)

O código do `chatFn` é TypeScript (`api/index.ts`) e é compilado para JS
(`api/index.js`) antes de ser empacotado pelo CDK via
`lambda.Code.fromAsset('api')`. Antes de qualquer `cdk deploy`, rode o build:

```bash
cd Desafio-1/luiz-henrique/api
npm install   # instala @aws-sdk/client-bedrock-runtime, typescript, @types/node
npm run build # tsc -> gera index.js (artefato do Lambda)
```

Para testar o Lambda localmente sem o CDK, rode o JS compilado com o profile:

```bash
cd Desafio-1/luiz-henrique/api
AWS_PROFILE=local node index.js   # invoca o handler diretamente contra o ministack :4566
```

> ⚠️ Nota: o profile `local` só tem `region = us-east-1` (sem credenciais). Para o `cdk deploy` autenticar e criar a stack na AWS, mantenha credenciais default disponíveis (ex.: `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` exportadas, ou um profile com SSO). O profile `local` controla **só o endpoint do Bedrock no Lambda**, não o alvo do deploy do CDK.

---

## Deploy com CDK contra o MiniStack (local)

Siga o mesmo padrão usado no `cdk-hello-world` de referência:

### 1. Levantar o MiniStack

```bash
cd Desafio-1/luiz-henrique/dev-tools
docker compose up -d
```

### 2. Exportar variáveis e fazer o deploy (comando único na raiz)

> ⚠️ Pré-requisito: antes de qualquer `cdk deploy` contra o MiniStack, os
> containers do Docker precisam estar rodando:
>
> ```bash
> cd Desafio-1/luiz-henrique/dev-tools
> docker compose up -d
> ```
>
> Só então execute o deploy a partir da raiz:

Vá para a raiz do seu diretório (`Desafio-1/luiz-henrique/`) e rode um único `cdk deploy`:

```bash
cd Desafio-1/luiz-henrique

# Carregar variáveis de ambiente local (MiniStack)
set -a && . .env.example && set +a

# Instalar dependências do CDK (primeira vez)
npm install

# Bootstrap (primeira vez) e deploy — tudo em um comando
cdk bootstrap && cdk deploy --require-approval never
```

O `cdk.json` na raiz roda `cd infra && npx tsc && npx tsx bin/desafio-1.ts`, ou seja: compila todo o TS da infra e executa o app CDK com `tsx`, tudo a partir da raiz.

**Como o switch local vs AWS funciona no deploy:**

| Comando | Profile | Endpoint Bedrock do Lambda |
|---------|---------|---------------------------|
| `AWS_PROFILE=local cdk deploy` | `local` | `http://localhost:4566` (MiniStack → llama.cpp/Qwen3.5) |
| `AWS_PROFILE=desafio-1 cdk deploy` | `desafio-1` | Bedrock real us-east-1 (Claude Haiku) |

O `api-stack.ts` lê `process.env.AWS_PROFILE` no momento da síntese (CDK) e injeta `BEDROCK_ENDPOINT_URL` no Lambda. Assim, o endpoint é definido no próprio template do CloudFormation — não há código condicional no runtime.

> ⚠️ Nota: o profile `local` só tem `region = us-east-1` (sem credenciais). Para o `cdk deploy` autenticar e criar a stack na AWS (mesmo contra o MiniStack local), mantenha credenciais default disponíveis (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` exportadas, como no `.env.example`).

### 3. Invocar o Lambda diretamente

```bash
# Listar funções para encontrar o nome gerado
aws --endpoint-url=http://localhost:4566 lambda list-functions

# Invocar a função do chat
aws --endpoint-url=http://localhost:4566 lambda invoke \
  --function-name luiz-henrique-chat \
  --payload '{"messages":[{"role":"user","content":[{"text":"Ola"}]}]}' \
  output.txt

cat output.txt
```

### 4. Acessar via API Gateway (workaround do MiniStack)

O MiniStack não implementa todos os endpoints da API Gateway, então `curl http://.../prod/hello` não funciona diretamente. Use o padrão de referência:

```bash
# Descobrir o ID da API REST
aws --endpoint-url=http://localhost:4566 apigateway get-rest-apis

# Chamar o endpoint via curl (substitua <api_id> pelo valor retornado)
curl http://localhost:4566/restapis/<api_id>/prod/_user_request_/chat \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <seu-jwt>" \
  -d '{"messages":[{"role":"user","content":[{"text":"Lista os produtos"}]}]}'
```

---

## Deploy na AWS real (sem MiniStack)

Apenas mude o profile:

```bash
cd Desafio-1/luiz-henrique
AWS_PROFILE=desafio-1 cdk deploy --require-approval never
```

O Lambda receberá `BEDROCK_ENDPOINT_URL` vazio e usará o Bedrock real (us-east-1, Claude Haiku).

---

## Teste de integração — chat local via MiniStack

O script `dev-tools/test-chat-local.py` simula o fluxo de chat do desafio chamando diretamente o Bedrock emulator do MiniStack (que por sua vez usa o llama.cpp/Qwen3.5):

```bash
cd Desafio-1/luiz-henrique/dev-tools
python3 test-chat-local.py
```

Ele faz:
1. `POST /chat`-like → `bedrock.converse(modelId="qwen3.5")` no MiniStack.
2. Lista o catálogo via tool `listar_catalogo`.
3. Registra uma intenção de compra.
4. Exibe a resposta gerada pelo Qwen3.5 através da Bedrock.

---

## Observações

- O `compose.yaml` usa a rede `dev-tools-network` (autocontida). Não depende da rede externa `llama-network`.
- O modelo ativo é `unsloth/Qwen3.5-2B-GGUF:UD-Q8_K_XL` (Qwen3.5 2B Q8). Ajuste `LLAMA_ARG_HF_REPO` se quiser outro quant.
- Qwen3 emite `reasoning_content` (modo de pensamento); o campo `content` da Bedrock pode vir vazio se o modelo estiver pensando — isso é comportamento do Qwen3, não erro do MiniStack.
- Para usar com a rede externa `llama-network` (se o `llama-server-cuda-small` já estiver rodando), aponte `MINISTACK_BEDROCK_PROXY_URL=http://host.docker.internal:1203` e rode o MiniStack com `--network llama-network`.
- Não commitar segredos: nenhum `.env` com chaves de acesso; `test/test` são credenciais fictícias do emulador local.
