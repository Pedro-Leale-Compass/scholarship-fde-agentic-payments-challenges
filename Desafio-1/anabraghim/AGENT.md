# AGENT.md — Migração do Chatbot de Pagamentos para AWS

Guia de trabalho para quem (pessoa ou agente de IA) continuar este projeto. Registra o objetivo, as regras combinadas, as decisões de arquitetura, o que já existe, o que falta e os erros já cometidos.

> **Para qualquer agente de IA** (Claude Code, Copilot, Cursor, Codex…): este arquivo é a fonte de contexto do projeto e não depende de ferramenta. Antes de mexer no código:
>
> 1. Leia **Regras de trabalho** e siga-as sem exceção.
> 2. Consulte **Decisões de arquitetura** antes de propor outra abordagem; mudar uma decisão é escolha da Ana.
> 3. Leia **Erros aprendidos** para não repetir problemas já resolvidos.
> 4. Ao terminar uma feature, atualize o status e registre aqui as decisões novas e os erros encontrados.

## Objetivo

Levar para a AWS o chatbot da Fase 1 sem mudar as regras de negócio:

```
Frontend (S3 privado + CloudFront/OAC, login Cognito)
   │ HTTPS + Authorization: Bearer <JWT Cognito>
   ▼
API Gateway REST (autorizador Cognito, 401 sem token, streaming)
   ▼
Lambda do chat (usuario_id = claims.sub; histórico no DynamoDB)
   ▼
Agente Strands (Python) no Bedrock AgentCore Runtime — Claude Haiku no Bedrock
   │ lambda.invoke({ usuario_id, argumentos })
   ▼
Lambdas das tools (TS): listar_catalogo · registrar_intencao · realizar_compra
   ▼
DynamoDB: usuarios · conversas · produtos · intencoes · transacoes
```

Tudo em **us-east-1**, definido em **CloudFormation** (`infra/`), com prefixo **`ana-braghim`** na stack e nos recursos.

## Regras de trabalho

- **AWS só com autorização da Ana**: durante o desenvolvimento (F0 a F11) nenhum comando `aws` foi executado; tudo era testado com mocks e uma AWS CLI falsa. Depois disso, o deploy é da Ana: comandos que criam, alteram ou apagam recursos só quando ela pedir, e nunca o `destroy.sh` por conta própria.
- **Nunca `git push`**. Enviar para o remoto e abrir PR é responsabilidade da Ana.
- **A Ana escolhe a próxima feature** e revisa cada uma antes da seguinte. Decisões de arquitetura são dela: o agente propõe opções com prós e contras.
- Uma branch por feature (`feature/<nome>`), commits pequenos e descritivos em português. Para a entrega, o histórico foi reorganizado na branch `fellow/anabraghim-desafio-1`.
- A cada feature: atualizar este arquivo (status, decisões e erros aprendidos) e o `PASSOS-RESTANTES.md`.
- **Este arquivo é versionado** (de novo, desde 16/11/2026, para documentar o uso de IA no projeto); o README aponta para ele. Não registrar aqui segredos, e-mails, ids de conta ou dados pessoais.
- **O `PASSOS-RESTANTES.md` não é versionado** (roteiro local de deploy, no `.gitignore`). Nada versionado deve apontar para ele: o README tem o próprio roteiro de deploy.
- Sempre editar o CloudFormation (`infra/template.yaml`) quando a feature criar recurso.
- Nenhum segredo, chave ou credencial no código ou no histórico.
- Verificar localmente antes de commitar: `tsc --noEmit`, testes (vitest/pytest com AWS mockada), `cfn-lint`, `bash -n`, build do frontend.

## Decisões de arquitetura

| Tema | Decisão | Motivo |
|---|---|---|
| Estrutura | `frontend/ api/ agent/ tools/ infra/` na raiz | Escolha da Ana; facilita copiar para `fellows/ana-braghim/` depois |
| Agente | Strands Agents em **Python** + `bedrock-agentcore` | SDK mais maduro e com mais exemplos no AgentCore |
| Chat e tools | Lambdas em **TypeScript** | Reaproveita contratos, mensagens e regras da Fase 1; streaming de resposta em Lambda é nativo em Node |
| API | **API Gateway REST** + autorizador `COGNITO_USER_POOLS` + response streaming, rotas sob `/api` | 401 nativo sem chegar na Lambda; streaming atende o requisito de UX e alivia o limite de 29 s |
| Deploy sem CloudFront | Parâmetro `ComFrontend` (`sim`/`nao`) e condição `CriarFrontend` nos 6 recursos de hosting e nos 3 Outputs; `SEM_FRONTEND=1 ./infra/deploy.sh` pula o build e a publicação do site e gera `frontend/public/config.json` e `frontend/.env.local` para o `npm run dev` | Pedido do gestor enquanto o CloudFront da conta tem problema de permissão. Opção A, condição permanente, escolhida pela Ana. Religar só **acrescenta** o hosting à stack, e uma falha nessa atualização volta ao estado anterior sem derrubar o backend |
| CORS | **Nenhum**: o CloudFront serve o frontend e encaminha `/api/*` para a API, na mesma origem | Sem `OPTIONS` nem origem para configurar; menos superfície. Decisão da Ana na F7 |
| Logs da API | Desligados; diagnóstico pelos logs das Lambdas | Exigem a role do `AWS::ApiGateway::Account`, que vale para a conta inteira (compartilhada com a turma) |
| Tools | Agente invoca as Lambdas direto (`lambda.invoke`) | `usuario_id` vai no evento, fora dos argumentos que o modelo preenche (substitui o `_meta` do MCP) |
| Modelo | **Claude Haiku 4.5**: inference profile `us.anthropic.claude-haiku-4-5-20251001-v1:0` (parâmetros `ModeloId` e `ModeloBaseId`) | Baixa latência e custo. O Haiku 5.5 era o plano, mas a conta do programa o recusa (*"not available for this account"*); o 4.5 foi testado e funciona. Decisão da Ana antes do primeiro deploy |
| Banco | 5 tabelas DynamoDB separadas, PAY_PER_REQUEST | Menor privilégio por tabela |
| Limite | Saldo `limite_disponivel` com decremento condicional | DynamoDB não tem SUM; escrita condicional evita duplicidade |
| Dinheiro | Centavos (inteiros) internamente, reais nos contratos | Evita ponto flutuante |
| IaC | Stack de bootstrap (bucket de artefatos) + stack principal; `infra/deploy.sh` | Um comando cria o ambiente inteiro |

### Modelagem DynamoDB

Todas as tabelas se chamam `ana-braghim-<nome>`, são PAY_PER_REQUEST e têm criptografia SSE. Estão definidas na F3.

| Tabela | Chave | Atributos |
|---|---|---|
| `usuarios` | PK `usuario_id` (sub do Cognito) | `limite_total_centavos`, `limite_disponivel_centavos`, `criado_em` |
| `conversas` | PK `usuario_id`, SK `sk` = `msg#<ts>#<seq>` | `role`, `content` (lista de blocos no formato do Strands/Bedrock: `text`, `toolUse`, `toolResult`, `reasoningContent`). Um item por mensagem |
| `produtos` | PK `produto_id` | `nome`, `preco_centavos`, `moeda`, `estoque`, `categoria` |
| `intencoes` | PK `intencao_id` | `usuario_id`, `produto_id`, `quantidade`, `valor_unitario_centavos`, `valor_total_centavos`, `moeda`, `status`, `expira_em`, `criado_em`, `ttl` (TTL ativo) |
| `transacoes` | PK `intencao_id` | `transacao_id`, `usuario_id`, `valor_centavos`, `moeda`, `metodo_pagamento`, `status`, `criado_em` |

- **Limite padrão**: um usuário sem registro em `usuarios` é criado na primeira compra com R$ 500,00 (put condicional, F4). O `criar-usuario.sh` pode gravar antes um limite customizado.
- **`ttl` das intenções** só faz a limpeza: o DynamoDB pode levar horas para apagar. `INTENCAO_EXPIRADA` é sempre decidida pelo `expira_em`.
- **Filtro por categoria** usa Scan com FilterExpression. O catálogo tem 3 itens; com catálogo grande, seria um GSI por `categoria`.

`realizar_compra` grava tudo num único `TransactWriteItems`: intenção `pendente → paga` (condição de status e dono), limite (condição `>= valor`), estoque (condição `>= quantidade`) e transação (`attribute_not_exists`). Uma chamada repetida falha na condição e vira `INTENCAO_JA_PAGA`.

### Fluxo de identidade

`JWT → autorizador do API Gateway → Lambda do chat lê claims.sub → InvokeAgentRuntime({ usuario_id, mensagens }) → agente guarda usuario_id no contexto (não é parâmetro de @tool) → lambda.invoke(tool, { usuario_id, argumentos })`. Só a role do AgentCore pode invocar as Lambdas de tool.

### IAM (menor privilégio)

| Role | Pode | Não pode |
|---|---|---|
| Lambda do chat | `bedrock-agentcore:InvokeAgentRuntime` no runtime e no endpoint `DEFAULT`; `Query`/`PutItem` em `conversas` | intenções, transações, Bedrock |
| Lambda do histórico | `Query` em `conversas` | escrita, o resto |
| Lambda do perfil | `GetItem` em `usuarios` | o resto |
| AgentCore Runtime | `bedrock:InvokeModel*` no inference profile e no modelo base (us-east-1, us-east-2, us-west-2); `lambda:InvokeFunction` nas 3 tools; logs e identidade de workload só do próprio runtime | tabelas, outros modelos |
| Cada tool | só as tabelas e ações que usa | `*`, admin |
| Bucket do frontend | `s3:GetObject` apenas pela distribuição (OAC) | acesso público |

## ✅ Já implementado (Fase 1, local)

- Regras de negócio: catálogo, intenção com TTL de 15 min, compra com `cartao` ou `pix`, limite por usuário.
- Contratos das 3 tools e formato de recusa `{ status: "recusado", erro, mensagem }`.
- Códigos: `INTENCAO_INVALIDA`, `INTENCAO_EXPIRADA`, `INTENCAO_JA_PAGA`, `LIMITE_EXCEDIDO`, `METODO_INVALIDO`, além de `PRODUTO_NAO_ENCONTRADO`, `ESTOQUE_INSUFICIENTE` e `FALHA_NA_FERRAMENTA`.
- Valor da compra lido da intenção gravada, nunca do modelo.
- Identidade fora dos argumentos das tools (`_meta` do MCP).
- Corrida de pagamento fechada com `UPDATE ... WHERE status = 'pendente'`.
- Isolamento entre usuários (busca por `id` **e** `userId`).
- Histórico completo enviado ao modelo a cada turno.

Referências da Fase 1 (removidas na F10, disponíveis no histórico do git, commit `fe92855` da `main`): `backend/src/services/purchase.ts`, `backend/src/services/agent.ts` e `mcp-server/src/tools/`. Ex.: `git show fe92855:backend/src/services/purchase.ts`. As regras foram portadas para `tools/src/` e o prompt para `agent/agente/prompt.py`.

## ☐ A implementar (ordem sugerida, a Ana decide)

- [x] **F0 — Plano e docs**: este arquivo e `PASSOS-RESTANTES.md` (branch `docs/plano-migracao-aws`).
- [x] **F1 — Estrutura e infra base** (branch `feature/infra-base`): pastas `api/ agent/ tools/ infra/`, `.gitignore`, `.gitattributes`, `infra/bootstrap.yaml` (bucket de artefatos privado, só HTTPS), `infra/template.yaml` (parâmetro `Prefixo`, regra us-east-1, placeholder), `infra/config.sh`, `deploy.sh` e `destroy.sh` (esqueletos com TODOs por feature).
- [x] **F2 — Cognito** (`feature/cognito-base`): UserPool `${Prefixo}-usuarios` com `AllowAdminCreateUserOnly: true`, `InviteMessageTemplate` em pt-BR, login por e-mail, política de senha e senha temporária de 7 dias; app client público (sem secret, SRP + refresh, tokens de 1 h); Outputs `UserPoolId`, `UserPoolArn` e `UserPoolClientId`; `infra/scripts/criar-usuario.sh`. A gravação do limite no DynamoDB fica como TODO para a F3.
  - Para a F8: o Amplify deve usar `loginMechanisms: ["email"]` e `<Authenticator hideSignUp>`.
- [x] **F3 — DynamoDB** (`feature/dynamodb`): 5 tabelas no template, cada uma com seu Output; `infra/seed/produtos.jsonl` (os 3 produtos da Fase 1, preços em centavos); `infra/scripts/seed-catalogo.sh`, chamado pelo `deploy.sh`, que só grava produto inexistente e não reseta o estoque; `criar-usuario.sh` grava o limite com put condicional; helpers `reais_para_centavos` e `put_item_se_nao_existir` em `config.sh`.
- [x] **F4 — Tools em Lambda (TS)** (`feature/tools-lambda`): pacote `tools/` com 3 handlers (Node 22, arm64, bundle esbuild) e regras portadas com as mesmas mensagens; `realizar_compra` com `TransactWriteItems` de 4 itens condicionais e tradução das `CancellationReasons`; usuário sem registro nasce com R$ 500 (put condicional); `QUANTIDADE_INVALIDA` novo; exceções → `FALHA_NA_FERRAMENTA`. No template: 3 funções, 3 roles mínimas (sem `*`) e 3 log groups com retenção de 14 dias, mais Outputs `Tool*Arn`. 33 testes vitest com DynamoDB mockado. O `deploy.sh` roda `npm ci`, test e build.
  - Para a F5: o agente invoca as funções com `{ usuario_id, argumentos }` e repassa ao modelo o JSON devolvido. A role do runtime precisa de `lambda:InvokeFunction` nos 3 ARNs.
- [x] **F5 — Agente Strands (Python)** (`feature/agente-strands`): pacote `agent/` com o entrypoint `BedrockAgentCoreApp`, `BedrockModel` (Haiku 5.5 no plano; trocado para o 4.5 no deploy), system prompt da Fase 1, 3 `@tool(context=True)` que invocam as Lambdas com o `usuario_id` do `invocation_state`, histórico completo (`NullConversationManager`) e teto de 8 turnos. Saída em SSE com os eventos `texto`, `ferramenta`, `fim` (com as `mensagens_novas` para gravar) e `erro`. Payload validado (GUID, roles, blocos permitidos, mensagem nova só com texto). No template: parâmetros `AgenteCodigoBucket`, `AgenteCodigoChave`, `ModeloId` e `ModeloBaseId`; `AgenteRole` (trust com `aws:SourceAccount`/`SourceArn`, sem `*`); `AWS::BedrockAgentCore::Runtime` (código no S3, `PYTHON_3_12`, `PUBLIC`, `HTTP`); Outputs `AgenteRuntimeArn` e `AgenteRuntimeId`. `empacotar.py` gera o zip ARM64 determinístico a partir do `requirements.lock`. O `deploy.sh` testa, empacota, publica em `agente/<sha256>.zip` e cria o log group com 14 dias; o `destroy.sh` apaga esse log group. O bootstrap passa a expirar só o prefixo do `package`. 43 testes pytest com modelo roteirizado e Lambda stubada.
  - Para a F6: chamar `InvokeAgentRuntime` com `agentRuntimeArn` = Output `AgenteRuntimeArn`, `qualifier` `DEFAULT` e `runtimeSessionId` de 33 caracteres ou mais (ex.: `usuario_id` + algo), e ler o SSE. Montar `mensagens` = histórico do DynamoDB + `{role: "user", content: [{text}]}`. Só gravar as `mensagens_novas` do evento `fim`. Nunca aceitar do frontend nada além do texto do usuário. A role do chat precisa de `bedrock-agentcore:InvokeAgentRuntime` no ARN do runtime e nos endpoints dele (`<arn>/runtime-endpoint/*`).
- [x] **F6 — Lambdas da API (TS)** (`feature/api-chat`): pacote `api/` com 3 Lambdas (Node 22, arm64, esbuild).
  - `ana-braghim-api-chat` (`POST /chat`, response streaming): lê as últimas 399 mensagens (corte alinhado ao texto do usuário), chama `InvokeAgentRuntime` com sessão por usuário, repassa o SSE do agente como NDJSON (`texto`, `ferramenta`, `fim`, `erro`) e grava o turno numa `TransactWriteItems`, só no `fim` válido. Falha antes do stream vira 502 JSON.
  - `ana-braghim-api-conversas` (`GET /conversas`): só texto, para a tela.
  - `ana-braghim-api-perfil` (`GET /perfil`): e-mail e limite em reais, com padrão de R$ 500 sem registro.

  No template: 3 roles mínimas, 3 log groups de 14 dias e Outputs `ApiChatArn`, `ApiConversasArn` e `ApiPerfilArn`. O `deploy.sh` roda `npm ci`, test e build. São 38 testes vitest com DynamoDB e AgentCore mockados.
  - Para a F7: a rota do chat usa a integração Lambda proxy com `ResponseTransferMode: STREAM` e a URI `.../2021-11-15/functions/<arn>/response-streaming-invocations`, com timeout de integração maior que 29 s (até 15 min). `/conversas` e `/perfil` usam a integração comum. É preciso um `AWS::Lambda::Permission` para `apigateway.amazonaws.com` em cada função, com `SourceArn` restrito à API/stage/método. (Na F7, o CORS foi removido: mesma origem via CloudFront.)
  - Para a F8: enviar o **ID token** no `Authorization`, porque o autorizador `COGNITO_USER_POOLS` aceita o ID token e o `/perfil` lê a claim `email`, que só existe nele. Ler o `/chat` com `fetch` + `ReadableStream` linha a linha (NDJSON). Contratos em `api/README.md`.
- [x] **F7 — API Gateway** (`feature/api-gateway`): REST regional `ana-braghim-api` com autorizador `COGNITO_USER_POOLS` (header `Authorization`, ID token) nos 3 métodos.
  - Rotas e integrações: `POST /api/chat` com Lambda proxy `STREAM` (URI `2021-11-15/.../response-streaming-invocations`, timeout de 190 s); `GET /api/conversas` e `GET /api/perfil` com proxy comum.
  - Erros do próprio API Gateway em português: 401, 403, 404 (no lugar de "Missing Authentication Token"), 429, 4XX e 5XX.
  - Stage `prod` com limite de 10 req/s (pico 20) e métricas.
  - 3 `AWS::Lambda::Permission` com `SourceArn` exato (API/prod/método/rota).
  - Outputs `ApiId`, `ApiStageNome`, `ApiUrl` e `ApiDominio`.
  - O CORS foi removido das Lambdas (opção "mesma origem" escolhida pela Ana).
  - O `deploy.sh` cria um deployment novo no stage a cada execução.
  - `infra/verificar_template.py` (com o parser do cfn-lint) falha se algum método não tiver Cognito, se o chat não usar `STREAM`, se faltar `SourceArn` ou se houver `*`/política gerenciada nas roles.
  - Para a F9: comportamento `/api/*` do CloudFront com origem `ApiDominio` e origin path `/prod`, cache desligado, origin request policy `AllViewerExceptHostHeader` (repassa o `Authorization` e o corpo, sem o `Host`, que o API Gateway rejeitaria) e métodos permitidos incluindo `POST`. O response timeout da origem tem padrão de 30 s **entre pacotes**: subir para 60 s e, se pausas longas aparecerem (tools e raciocínio), avaliar um evento de keep-alive no chat.
- [x] **F8 — Frontend** (`feature/frontend-cognito`): `aws-amplify` 6 e `@aws-amplify/ui-react` 6.
  - **Login:** `<Authenticator hideSignUp>` em pt (`I18n` + `translations`), login por e-mail; o Authenticator cuida da troca da senha temporária do convite e do "esqueci a senha".
  - **Configuração:** `/config.json` lido em runtime e validado (`userPoolId`, `userPoolClientId`); sem ele, aparece uma tela de erro.
  - **API:** todas as chamadas em `/api/*` na mesma origem, com o **ID token** de `fetchAuthSession`; um 401 faz logout. O `POST /api/chat` envia só `{ mensagem }` e lê o NDJSON com `ReadableStream`.
  - **Tela:** eventos aplicados por funções puras (`lib/conversa.ts`): o texto depois de uma tool abre balão novo, igual ao histórico recarregado; erro ou queda de conexão vira balão de aviso; o indicador "consultando…" aparece por tool. O histórico vem de `GET /api/conversas` e o limite de `GET /api/perfil`, atualizado no `fim`.
  - **Removidos:** `LoginPage`, `RegisterPage`, `Auth.css`, `lib/auth.tsx`, `src/api.ts`, o tipo de mensagem da OpenAI e o `react-router-dom`.
  - **Dev local:** o Vite repassa `/api` para `API_URL` (`.env.local`).
  - **Verificação:** 24 testes vitest; build e oxlint limpos.
  - Para a F9: gerar `frontend/public/config.json` (ou direto em `dist/`) a partir dos Outputs `UserPoolId` e `UserPoolClientId` **depois** do `npm run build`, e enviar o `config.json` e o `index.html` com `Cache-Control: no-cache` (os assets com hash podem ter cache longo). O bundle tem cerca de 935 kB (260 kB gzip), principalmente do Amplify UI; aceitável, e code splitting fica como melhoria.
- [x] **F9 — Hosting + deploy completo** (`feature/hosting-cloudfront`):
  - **Bucket do site:** `ana-braghim-site-<account>` privado (bloqueio público total, `BucketOwnerEnforced`, SSE, só HTTPS) e lido **só pela distribuição** (OAC + `AWS:SourceArn`).
  - **CloudFront:** um domínio para tudo.
    - `/*` vem do S3, com cache `CachingOptimized` e response headers policy com HSTS, CSP restrita (`connect-src` só o próprio site e `cognito-idp.<região>`), nosniff, frame DENY e referrer.
    - `/api/*` vai para o API Gateway (origin path `/prod`, só HTTPS, TLS 1.2), sem compressão, com a cache policy própria `api-sem-cache` (TTL 0 com `Authorization` na chave, senão o CloudFront não repassa o header em GET) e com `AllViewerExceptHostHeader`. O `OriginReadTimeout` é de 60 s.
    - Sem `CustomErrorResponses`: o app não tem rotas e elas mascarariam os 401/404 da API.
  - **Pulso no chat:** a Lambda envia `{"tipo":"pulso"}` a cada 15 s durante o stream, e o frontend ignora o evento. O handler passa só `(evento, stream)` para o `processarChat`, porque o runtime manda o `context` como terceiro argumento.
  - **`deploy.sh`:**
    - `build_frontend` roda `npm ci`, os testes e o build, e copia para `infra/build/site`.
    - `publicar_frontend` gera o `config.json` dos Outputs (validados), faz o `s3 sync` de `assets/` com cache de 1 ano e do resto com `no-cache`, invalida `/*` e imprime a URL.
  - **`destroy.sh`:** esvazia o bucket do site antes de apagar a stack.
  - **Outputs:** `SiteBucketNome`, `DistribuicaoId` e `SiteUrl`.
  - **Verificação:** o `verificar_template.py` passou a checar o bloqueio público dos buckets, que o bucket do site só libere a distribuição, que o CloudFront use só HTTPS, `/api/*` sem compressão e OAC na origem S3.
- [x] **F10 — Remoção do legado** (`chore/remover-legado`):
  - Removidos do git `backend/` (Hono, Postgres/Drizzle, migrations, JWT próprio com bcrypt, cliente OpenRouter, docker-compose) e `mcp-server/` (tools via stdio).
  - Removidas as sobras do template do Vite no frontend, que não eram usadas: `App.css`, `src/assets/` e `public/icons.svg`.
  - No disco, sobravam só o `node_modules` e duas pastas de migration vazias e não versionadas; conferidas antes de apagar.
  - As referências viraram ponteiros para o histórico (`git show fe92855:<arquivo>`).
  - O README da raiz ganhou um aviso de que descreve a Fase 1, até ser reescrito na F11. As capturas em `screenshots/` também são da Fase 1 e serão substituídas depois do deploy.
  - Nenhum pacote novo depende do código removido: tools, API e frontend têm testes e build próprios, e o agente tem os próprios testes.
- [x] **F11 — README final** (`docs/readme-final`): README da raiz reescrito para a AWS.
  - **Conteúdo:**
    - diagrama Mermaid da arquitetura e o caminho de uma mensagem;
    - tabela dos requisitos do desafio, com onde cada um está;
    - deploy passo a passo (pré-requisitos, preparação da conta, `./infra/deploy.sh`, convites e validação);
    - como usar, com o catálogo e os roteiros de cada recusa;
    - modelo do Bedrock (Haiku 4.5, inference profile e motivo);
    - modelagem do DynamoDB;
    - permissões IAM por role e as políticas de recurso;
    - evidências, remoção dos recursos, estrutura, testes locais e decisões e limitações.
  - **Capturas:** a seção de evidências aponta para `screenshots/aws/01..06` (obrigatórias). `screenshots/aws/README.md` descreve o que cada imagem deve mostrar e lista as opcionais (07 a 11). As capturas da Fase 1 foram apagadas a pedido da Ana: `screenshots/` guarda só as evidências da AWS.
  - **`tools/README.md`:** ganhou a tabela completa dos códigos de recusa.
  - **Capturas:** salvas pela Ana depois do deploy real (`0` a `6`) e exibidas no README.
- [x] **Depois do deploy** (direto na `fellow/anabraghim-desafio-1`):
  - Visual do chat e da tela de login modernizado.
  - README reorganizado: diagrama Mermaid, modelagem do DynamoDB, IAM por role e `Sid`, seção sobre o uso de IA.
  - E-mail de convite do Cognito personalizado (identifica o projeto e avisa que os pagamentos são simulados).
  - Este arquivo voltou a ser versionado.
- [ ] **F12 (extra) — AgentCore Gateway MCP**: Lambdas como tools MCP com propagação segura do `usuario_id`.

## Erros aprendidos

- **`z.guid()` e não `z.uuid()`**: `z.uuid()` exige o nibble de versão do RFC 4122 e recusava ids válidos. Na AWS os ids continuam sendo validados antes de ir ao banco, para que um id inventado vire `INTENCAO_INVALIDA` ou `PRODUTO_NAO_ENCONTRADO` em vez de erro cru.
- **`metodo_pagamento` como string validada no handler**: com enum no schema, o SDK recusava antes do handler e `METODO_INVALIDO` não voltava no formato padrão. Manter na Lambda.
- **Dinheiro em ponto flutuante**: gerou `4750.000000000001`. Agora tudo é calculado em centavos.
- **Dependências cruzadas entre pacotes** (Fase 1): o `mcp-server` importava `drizzle` de `backend/` e quebrava se resolvido de outro lugar. Cada pacote (`api/`, `tools/`, `agent/`) precisa ter as próprias dependências e bundle independente.
- **Encoding**: alguns fontes aparecem com acentos corrompidos (mojibake) quando lidos no PowerShell. Salvar sempre em UTF-8 e conferir acentos antes de commitar.
- **Ambiente Windows**: o shell padrão é PowerShell 5.1 (sem `&&`). Scripts de deploy são bash e rodam pelo Git Bash.
- **Git sem identidade**: o repo estava sem `user.name`/`user.email`. Foi configurado localmente como Ana Braghim.
- **CRLF em scripts bash**: com `core.autocrlf=true`, o git converteria `.sh` para CRLF e o bash quebraria (`$'\r': command not found`). O `.gitattributes` força `*.sh eol=lf`.
- **`bash` no PowerShell é o WSL**, que não tem distro instalada. Para checar scripts, usar o Git Bash (ferramenta Bash), não `bash` dentro do PowerShell.
- **Template CloudFormation sem recurso é inválido**: o esqueleto usa um `AWS::CloudFormation::WaitConditionHandle` como placeholder. Remover na F2.
- **Validação offline**: `cfn-lint` não vem instalado. Usar um venv temporário (fora do repo): `python -m venv <tmp>/venv && <tmp>/venv/Scripts/pip install cfn-lint`.
- **Região travada no template**: a seção `Rules` faz o deploy falhar fora de us-east-1, antes de criar qualquer recurso.
- **Convite do Cognito**: o `EmailMessage` do `InviteMessageTemplate` precisa conter `{username}` e `{####}`, senão o deploy falha.
- **`UsernameAttributes: [email]` não pode ser alterado depois de criar o user pool**: mudar exige substituir o pool e perder os usuários. Por isso `UpdateReplacePolicy: Retain`.
- **`email_verified=true` no admin-create-user**: sem isso o usuário criado pelo admin não consegue recuperar a senha.
- **Scripts que chamam a AWS**: testar com uma **AWS CLI falsa** (stub `aws` no scratchpad, na frente do PATH), que registra as chamadas e simula respostas. **Antes de rodar, conferir `command -v aws`**: na F3 o stub foi posto no PATH como `C:/...`, o `:` quebrou o PATH e a AWS CLI real foi chamada. Ela só falhou por `NoCredentials`. No Git Bash use `/c/...` e aborte se o stub não for o primeiro.
- **Acentos em JSON passado para a AWS CLI no Windows**: usar escape `\u00e2` no arquivo (ASCII puro), para não depender do encoding do terminal. A ferramenta Edit converte `\uXXXX` no próprio caractere, então para gravar o escape use um script.
- **Sem `ClientRequestToken` no `TransactWriteItems`**: com o token, uma chamada repetida em até 10 minutos "dá certo" sem gravar nada, e a Lambda devolveria um `transacao_id` novo que não existe no banco. As condições já garantem a idempotência, e a repetição responde `INTENCAO_JA_PAGA`.
- **Pré-checagem não substitui a condição**: ler e depois escrever tem corrida. As leituras servem só para a mensagem certa. Quem garante limite, estoque e pagamento único são as `ConditionExpression` da transação. O `limite_restante` é relido depois da escrita.
- **cfn-lint e `Code` local**: o aviso é a **W3002** (código que só funciona com `package`), não E3012. Fica ignorado por recurso, em `Metadata.cfn-lint`, com comentário.
- **npm 11 bloqueia scripts de pós-instalação** (aviso no esbuild). O binário vem por `optionalDependencies` e o build funciona assim mesmo.
- **Parâmetro com valor default em helper de teste**: passar `undefined` ativa o default. Um teste de "sem usuario_id" passou a mandar o usuário padrão. Para testar ausência, chamar o handler direto.
- **pip e marcadores de plataforma**: `pip install --platform manylinux2014_aarch64` ainda avalia `sys_platform` pelo sistema local. No Windows ele tentou instalar `pywin32` (dependência do `mcp` só para Windows) e falhou. Solução: `requirements.lock` resolvido pelo `uv` para `aarch64-manylinux2014`, instalado com `--no-deps --require-hashes`.
- **Zip determinístico**: o pip do Windows gera `.exe` em `bin/` (e cita o hash deles nos `RECORD`), diferentes a cada build. Removidos antes de zipar, junto com datas fixas e ordem fixa. Sem isso, todo deploy atualizaria o runtime.
- **Nome do AgentCore Runtime não aceita hífen** (`[a-zA-Z][a-zA-Z0-9_]{0,47}`): o template faz `!Split`/`!Join` de `ana-braghim` para `ana_braghim_agente`. O id gerado é `<nome>-<sufixo>`, então as policies usam `<nome>-*` e evitam dependência circular com o próprio runtime.
- **Inference profile e IAM**: o profile `us.*` roteia para us-east-1, us-east-2 e us-west-2. A policy precisa do ARN do profile **e** do modelo base em cada uma dessas regiões, senão a chamada falha com AccessDenied. Os recursos do desafio continuam só em us-east-1.
- **Lifecycle do bucket de artefatos**: a expiração de 30 dias valia para o bucket todo e apagaria o zip que o runtime usa. Agora só expira `<prefixo>-pagamentos/`, e o agente fica em `agente/`.
- **Log group do AgentCore**: é criado pelo próprio serviço, sem retenção e com nome que depende do id gerado. Pré-criar no CloudFormation pode conflitar com o serviço. Por isso o `deploy.sh` cria o log group se não existir e aplica a retenção, e o `destroy.sh` o apaga.
- **Strands acrescenta campos internos às mensagens** (ex.: `tracking_id`): gravar só `role` e `content`.
- **Stubber do botocore não faz retry**: um erro de serviço enfileirado é consumido uma vez só. Enfileirar dois deixa resposta pendente e o teste falha no teardown.
- **Sem `temperature` no modelo**: os modelos Claude atuais recusam amostragem diferente do padrão (400).
- **`import "aws-lambda"` quebra em runtime**: o pacote só tem tipos. Para o global `awslambda` (streaming), usar `/// <reference types="aws-lambda" />`.
- **Invocar o agente antes de abrir o stream**: depois do `HttpResponseStream.from` o status 200 já foi enviado. Fazendo a chamada antes, uma falha do AgentCore vira um 502 de verdade. Depois disso, erros só podem ir como evento `erro`.
- **Histórico truncado precisa começar num turno**: cortar por quantidade pode começar num `toolResult` (role `user`), e o Bedrock rejeita a conversa. O corte avança até o próximo texto do usuário.
- **Gravar o turno em transação**: gravar mensagem a mensagem pode deixar um `toolUse` sem `toolResult` se falhar no meio, e todos os turnos seguintes quebrariam.
- **`noUncheckedIndexedAccess`**: checar `length` não estreita `valor[0]`. Guardar em variável e testar.
- **`AWS::ApiGateway::Deployment` não republica**: alterar um método não cria deployment novo, e o stage continua com a versão antiga. O `deploy.sh` faz `create-deployment` a cada execução.
- **Rota inexistente no API Gateway REST responde 403 "Missing Authentication Token"**: o `GatewayResponse` `MISSING_AUTHENTICATION_TOKEN` a transforma em 404 com mensagem clara.
- **Logs do API Gateway exigem configuração da conta inteira** (`AWS::ApiGateway::Account` com role do CloudWatch). Numa conta compartilhada, criar isso pela stack afetaria as outras stacks. Ficou desligado e documentado.
- **Mesma origem elimina CORS**: com `/api/*` no mesmo CloudFront do frontend, não há preflight nem headers de CORS para manter. Por isso as rotas ficam sob `/api` já na API, e o CloudFront não reescreve caminhos.
- **Heredoc do bash com aspas e `$(...)` no conteúdo** quebrou o comando de edição dos docs. Para scripts de edição, gravar o arquivo com a ferramenta Write.
- **Amplify v6 lê o mecanismo de login da config** (`Auth.Cognito.loginWith.email`); a prop `loginMechanisms` do Authenticator é legada. Com `hideSignUp`, a aba de cadastro some, mas o bloqueio real continua no user pool (`AllowAdminCreateUserOnly`).
- **ID token, não access token**: o autorizador `COGNITO_USER_POOLS` sem scopes valida o ID token, e só ele traz `email`.
- **oxlint `set-state-in-effect`**: chamar uma função que faz `setState` direto no corpo do efeito gera aviso, mesmo que o `setState` ocorra depois de um `await`. A chamada foi movida para dentro da função assíncrona.
- **CloudFront não repassa `Authorization` em GET/HEAD** só com a origin request policy: o header precisa estar na chave de cache, e a `CachingDisabled` não aceita headers. Daí a cache policy própria com TTL 0 e `Authorization` na chave.
- **Compressão no CloudFront pode segurar o streaming**: desligada no `/api/*`.
- **`CustomErrorResponses` vale para a distribuição inteira**: um "403/404 → index.html" para SPA mascararia os erros da API. Como o app não tem rotas, ficou sem.
- **Caminho `/c/...` do Git Bash como argumento do Node quebra no Windows** (vira `C:\c\...`). O build do frontend gera `dist/` no lugar padrão e o bash copia.
- **Handler com streaming recebe `(evento, stream, context)`**: um terceiro parâmetro opcional da função de negócio receberia o `context` da Lambda. Envolver numa arrow function com dois argumentos.
- **Antes de apagar uma pasta, ver o que não está no git**: o `git rm` só cuida dos arquivos versionados. O que sobra no disco (ex.: `.env` com chave real) pode não ter volta. Na F10 sobraram só o `node_modules` e pastas vazias.
- **Versão mínima do Node documentada errada**: os docs pediam "Node 20+", mas o vitest 5 e o vite 8 exigem 22.12+. Com Node 20 o deploy pararia nos testes. Corrigido no README e no roteiro, e o `deploy.sh` confere a versão logo no início. Ao subir a versão de uma ferramenta de build, conferir o `engines` dela.
- **Roteiro escrito aos poucos fica confuso**: o `PASSOS-RESTANTES.md` acumulou ✅/🚧, testes "antes do agente existir" e referências às features. Ele foi reescrito como roteiro único, em ordem: branch, ferramentas, credenciais, conta, deploy, usuários, validação, prints, entrega, limpeza e solução de problemas. Cada passo tem um "Esperado".
- **Arquivo ignorado é sobrescrito pelo git sem aviso**: depois de tirar um arquivo do versionamento (`git rm --cached` + `.gitignore`), um checkout de branch que ainda o versiona sobrescreve a cópia local, e ao voltar ela some. Fazer backup antes e evitar esses checkouts.
- **CRLF em `.sh` na cópia local**: editar scripts por Python (`Path.write_text` no Windows grava `\r\n`) ou por ferramentas de edição deixou `deploy.sh` e `config.sh` com CRLF no disco. O repositório ficou certo por causa do `.gitattributes`, e o bash do Git para Windows tolera CR, mas Linux e macOS quebrariam. Três armadilhas: (1) o `bash -n` não detecta; (2) `grep $'\r'` no Git Bash **não é confiável** e não acusou nada; contar com `tr -cd '\r' < arquivo | wc -c`; (3) `git checkout -- arquivo` **não reescreve** um arquivo que, depois da normalização, o git considera igual ao commit. Para corrigir, `rm arquivo && git checkout -- arquivo`. Depois de qualquer edição em `.sh`, recontar os CRs.
- **A AWS CLI v2 não tem `lambda invoke-with-response-stream`** (só os SDKs). O roteiro sugeria esse comando para testar a Lambda do chat; foi trocado pelo `logs tail` dela enquanto se usa o site. Antes de documentar um comando da CLI, conferir localmente com `aws <serviço> <comando> help`, que não chama a AWS.
- **Modelo no catálogo não significa modelo liberado**: o `us.anthropic.claude-haiku-5-5` aparecia como ACTIVE em `list-inference-profiles`, mas o `converse` respondeu *"not available for this account"*. Isso não é IAM: a role era `AlunoAdmin`, e uma falta de permissão diria *"not authorized to perform"*. É liberação do modelo por conta. Antes de escolher o modelo padrão, testar uma chamada real mínima (`--inference-config '{"maxTokens":10}'`) na conta de destino.
- **`aws cloudformation deploy` reaproveita o valor anterior de parâmetro omitido**: se o `ComFrontend=nao` não fosse sobrescrito explicitamente, um deploy normal depois do `SEM_FRONTEND=1` continuaria sem o site. O `deploy.sh` passa `ComFrontend` **sempre**.
- **Teste de função de script precisa do mesmo diretório**: copiar o `deploy.sh` para outra pasta quebrou o `source config.sh`, e o teste "passou" sem rodar a função. A cópia temporária precisa ficar em `infra/` e ser apagada depois.
- **Primeiro deploy real (Windows + Git Bash): o stub não pegou nada disto.** O stub da AWS CLI é um script bash, que não reproduz o executável do Windows. Quatro problemas:
  1. **`\r` na saída**: a AWS CLI do Windows termina a saída com `\r\n`, e o `$(...)` só tira o `\n`. O id do agente foi com `\r` para o nome do log group (`InvalidParameterException`), e o `sub` do usuário iria com `\r` para a chave do limite. Correção: `tr -d '\r'` em `output_da_stack` e no `criar-usuario.sh`. Os parâmetros da stack saíram limpos, porque a CLI apara argumentos.
  2. **Conversão de caminhos do MSYS**: argumentos começando com `/` (`/aws/...`, `--paths "/*"`) viram `C:/Program Files/Git/...`. Correção: `MSYS_NO_PATHCONV=1` só nesses comandos. Não pode ser global, porque os caminhos de arquivo `/c/...` precisam da conversão para o `aws.exe`.
  3. **Codificação**: a CLI lê o `template.yaml` em cp1252, então o e-mail de convite e as mensagens de erro chegaram com acento duplo (`OlÃ¡`). Correção: `AWS_CLI_FILE_ENCODING=UTF-8` e `AWS_CLI_OUTPUT_ENCODING=UTF-8` no `config.sh`. Porém o `cloudformation package` **grava** o empacotado em cp1252 mesmo assim; o `deploy.sh` o converte para UTF-8. Detectado comparando o **comprimento** do texto guardado na AWS com o do template (220 contra 213), porque a exibição no terminal não é confiável.
  4. **Propagação do API Gateway**: depois de um `create-deployment`, por alguns minutos parte das respostas ainda vem da versão anterior. Não é falha: esperar e testar várias vezes seguidas.
- **`sed` com `\\r` no Git Bash grava um CR de verdade**, e um Python em modo texto o transforma em quebra de linha. Para editar `\r` literal em arquivo, usar um script Python gravado em arquivo e trabalhar nos bytes (`bytes([92]) + b"r"`).
- **Seed idempotente**: `batch-write-item` não aceita condição e sobrescreveria o estoque a cada deploy. Por isso é um `put-item` por produto com `attribute_not_exists`.
- **Emoji no `template.yaml` quebra o deploy no Windows**: o `cloudformation package` grava em cp1252, que não tem emoji, e falha. Acentos funcionam (com a conversão do `deploy.sh`), emoji não. Manter o template sem emoji, inclusive no e-mail de convite.
