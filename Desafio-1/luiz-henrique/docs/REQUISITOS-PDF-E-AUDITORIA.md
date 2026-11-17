# Requisitos do PDF × estado atual × auditoria dos docs

Fonte: `desafio_1_sprint_2.pdf` (7 páginas, extraído com `pdftotext -layout` em 2026-11-17).
Escopo: inventário completo dos requisitos, status real no repositório, desvio autorizado
(frontend local), desenho do convite por e-mail e divergências encontradas na documentação.

Legenda de status: ✅ atende · 🟡 parcial · ❌ não atende · ⏸ adiado por decisão explícita.

> Status revisado em 2026-11-17 após a implementação de registro de usuários, convite por
> CLI, saldo transacional e códigos de erro. Onde a seção 4 aponta um problema de doc já
> corrigido, a linha está marcada como "(corrigido)".

## 1. Inventário do PDF

### 1.1 Contexto e arquitetura

- ✅ Migração do chatbot da Fase 1 (login + agente + 3 tools) para AWS.
- ✅ Regras de negócio da Fase 1 mantidas (catálogo, intenção, cartão/Pix, limite, validação).
- ✅ Tudo em `us-east-1`; prefixo `luiz-henrique` na stack e nos recursos.
- ✅ Comunicação frontend ↔ backend exclusivamente via API Gateway.
- 🟡 Variações de arquitetura: aceitas só se justificadas na documentação. O desvio do
  frontend local está justificado neste arquivo e no `README.md`, mas ainda não com o
  nível de detalhe que o PDF exige (ver §2).

### 1.2 Stack obrigatória

| Camada | Exigência do PDF | Status |
|---|---|---|
| Frontend | S3 privado + CloudFront + OAC, sem website hosting; URL pública | ⏸ adiado nesta rodada (frontend local). Não existe `frontend-stack.ts`; `infra/dist/lib/frontend-stack.d.ts` é artefato antigo de build |
| Config do frontend | Gerada pelo IaC no deploy (`config.json`) | 🟡 `scripts/dev-frontend-local.sh` gera a partir de `infra/cdk-outputs.json`, mas em tempo de dev, não no deploy |
| Auth | Cognito + `Authenticator`; `hideSignUp`; sem auto cadastro | 🟡 pool sem auto cadastro (`infra/lib/api-stack.ts:34`); `hideSignUp` ausente (`frontend/app/page.tsx:45`) |
| API | API Gateway + autorizador JWT Cognito | ✅ `infra/lib/api-stack.ts:93-103` |
| API (UX) | "Deve ser ou Stream ou WebSocket" | ❌ REST não-streaming (`infra/lib/api-stack.ts:80`) |
| Agente | Strands no AgentCore Runtime + modelo Bedrock | ✅ Claude Haiku 4.5, runtime READY |
| Tools | 3 Lambdas com os mesmos contratos e códigos de erro da Fase 1 | ✅ `realizar_compra` retorna `INTENCAO_INVALIDA`, `INTENCAO_EXPIRADA`, `INTENCAO_JA_PAGA`, `LIMITE_EXCEDIDO`, `METODO_INVALIDO`, `USUARIO_NAO_ENCONTRADO` |
| Banco | DynamoDB: usuários+limite, conversas, intenções/transações | 🟡 usuários e saldo gravados (convite + lazy upsert) e intenções/transações ok; conversas ainda não são gravadas |
| IaC | Um comando cria o ambiente completo, incluindo frontend | 🟡 `npm run deploy:api-agent` cria banco/tools/agente/API; pela decisão desta rodada não publica frontend |

### 1.3 Requisitos funcionais e de segurança

1. **Frontend e autenticação** — login Cognito; chat inacessível sem autenticação;
   identidade validada no backend a cada requisição. ✅ (`auth` no API Gateway;
   `sub` extraído em `api/index.ts:81-82`).
   - `hideSignUp` na tela: ❌.
   - Cadastro apenas por convite (`AllowAdminCreateUserOnly`): ✅.
   - Convite por e-mail com senha temporária: ✅ `scripts/invite-user.sh`
     (`npm run user:invite`), usando o envio nativo do Cognito.
   - Template de convite no IaC (`userInvitation`): ✅ (`infra/lib/api-stack.ts`).
2. **API Gateway** — endpoints de chat expostos; JWT obrigatório; 401 sem chegar à Lambda;
   `usuario_id` só do token; CORS restrito à origem do app. ✅, exceto:
   - `GET /conversas` (histórico) não existe — só `POST /chat`.
   - CORS limitado a `POST,OPTIONS` (`infra/lib/api-stack.ts:85`), incompatível com GET.
3. **Agente** — Strands no AgentCore, Bedrock no lugar do Ollama, histórico completo a cada
   turno. ✅.
4. **Ferramentas em Lambda** — 3 tools e contratos/códigos de erro da Fase 1. ✅ para os
   códigos de compra (ver 1.2).
5. **Persistência em DynamoDB** — usuários+limite, conversas, intenções/transações;
   modelagem explicada. 🟡:
   - conversas: tabela existe, nenhuma escrita/leitura no `api/` ou `agent/` — pendente;
   - usuários: ✅ criados pelo `invite-user.sh` e por lazy upsert no primeiro acesso;
     `limite_centavos` é saldo disponível, debitado na compra e ajustável por CLI (§3.2).
6. **Regras de segurança da compra**:
   - `usuario_id` da sessão, nunca do modelo: 🟡 o agente recebe `usuario_id` no payload
     do chat Lambda e o repassa às tools; as tools não revalidam contra o token.
   - valor da compra vem da intenção salva: ✅ (`tools/realizar_compra/index.ts:119`).
   - `realizar_compra` só aceita intenção do próprio usuário e não paga: ✅ compara
     `usuario_id` da intenção com o do chamador e valida `pendente` + `expira_em`.
   - idempotência: ✅ `ConditionExpression` em `registrar_intencao` e `realizar_compra`
     (`tools/registrar_intencao/index.ts:105`, `tools/realizar_compra/index.ts:147`).
7. **IAM de menor privilégio** — 🟡:
   - `ecr:GetAuthorizationToken` com `Resource: "*"` (`infra/lib/agent-stack.ts:81`) —
     exceção aceitável, mas precisa estar documentada;
   - `service-role/AWSLambdaBasicExecutionRole` anexada à role do runtime
     (`infra/lib/agent-stack.ts:62`) — policy de Lambda, desnecessária;
   - Lambda do chat: ✅ `GetItem`/`PutItem`/`UpdateItem` apenas em `Usuarios`;
     cada tool agora tem política própria (sem a policy compartilhada anterior).
8. **Deploy** — um comando documentado; prefixo; nada manual sem documentação. 🟡 (sem
   frontend por decisão desta rodada).
9. **Boas práticas** — `.gitignore` ok, sem segredos, pasta própria, commits/PR, erros
   compreensíveis ao usuário. 🟡: `realizar_compra` já devolve `code` + mensagem; o prompt
   do agente ainda precisa repassar o motivo ao usuário.

### 1.4 Critérios de conclusão

| Critério | Status |
|---|---|
| Frontend em S3+CloudFront com URL pública e OAC | ⏸ adiado |
| Login Cognito; chat inacessível sem autenticação | ✅ |
| Auto cadastro off; usuários só por convite do admin | ✅ política + convite por e-mail (`user:invite`) |
| Endpoints do webchat no API Gateway com JWT | 🟡 falta `GET /conversas` |
| 401 sem token no API Gateway | ✅ verificado (`docs/deploy-findings.md`) |
| Strands no AgentCore com modelo Bedrock | ✅ |
| 3 tools em Lambda | ✅ |
| Usuários, conversas e intenções no DynamoDB | 🟡 usuários+saldo e intenções ok; conversas pendentes |
| Roles de menor privilégio, sem curinga | 🟡 exceção do ECR + policy extra |
| Ambiente completo por um comando | 🟡 backend completo; frontend fora por decisão |
| PR com pasta, sem credenciais e README | 🟡 evidencias pendentes |

### 1.5 Entrega (README do PR)

1. Diagrama da arquitetura implementada — 🟡 existe, mas desatualizado (ver §4).
2. Deploy passo a passo — ✅.
3. Modelo Bedrock e justificativa — ✅.
4. Modelagem DynamoDB (tabelas, chaves, conteúdo) — ✅ atualizada no README.
5. Resumo IAM por role — ✅ atualizado no README (políticas por tool e do chat).
6. Evidências — ❌ todas pendentes: login, 401 via curl/Postman, compra cartão, compra Pix,
   limite excedido, `intencao_id` inválido.
7. Instruções de remoção — 🟡 citam app Amplify inexistente.

### 1.6 Custos, limpeza e extras

- ❌ Alerta no AWS Budgets antes do primeiro deploy: não há registro em nenhum doc.
- ✅ Acesso ao Claude Haiku confirmado em us-east-1.
- ✅ `npm run destroy` + `scripts/destroy-cleanup.sh` + `docs/destroy-cleanup.md`.
- ⏸ Extras (Gateway MCP, AgentCore Memory, Guardrails, traces): não previstos.
- ❌ Aplicação "no ar até a correção" e usuário do instrutor convidado: incompatível com o
  frontend local e sem fluxo de convite.

### 1.7 Convenção de pasta

O PDF exige `fellows/<seu-nome>/`; o repositório e o `README.md` da raiz usam
`Desafio-1/<seu-nome>/`. A entrega deve seguir a convenção do repo (decisão do time), mas
a divergência precisa estar registrada no README para quem corrigir.

## 2. Desvio autorizado nesta rodada: frontend local

Decisão: o frontend roda com `npm run dev:frontend` (`http://localhost:3000`) e a API,
agente e DynamoDB continuam na AWS.

Critérios do PDF afetados: S3+CloudFront+OAC, URL pública, `config.json` gerado no deploy,
"aplicação no ar até a correção" e a evidência de acesso pela URL do CloudFront.

Mitigações já existentes: `frontendUrl` centralizado em
`infra/lib/desafio-1-stack.ts:49`, CORS do API e `FRONTEND_URL` da Lambda derivados dele;
`scripts/dev-frontend-local.sh` gera `frontend/public/config.json` a partir dos outputs.

O que falta documentar: no `README.md`, uma seção "Desvio desta entrega" dizendo o que não
foi entregue (S3/CloudFront/OAC), por quê (SCP da conta bloqueia; decisão de rodar local) e
como o instrutor executa o projeto. Sem isso o critério é simplesmente não atendido.

## 3. Convite por e-mail via script CLI (desenho adotado)

Decisão: o convite é emitido por um script, sem painel admin e sem tabela de convites.
É mais simples e continua exatamente no modelo do PDF: usuário criado por administrador,
e-mail de convite com senha temporária e troca obrigatória no primeiro login.

Comando implementado: `npm run user:invite -- <email> [limite]`
(`scripts/invite-user.sh`):

1. `admin-create-user` no User Pool com e-mail como username, e-mail verificado e
   `--desired-delivery-mediums EMAIL`. O **próprio Cognito** envia o convite com a senha
   temporária (template `userInvitation` definido no CDK).
2. Lê o `sub` real com `admin-get-user`.
3. `put-item` em `Usuarios`: `usuario_id` (= sub), `email`, `limite_centavos` (argumento
   em reais convertido para centavos), `status=ativo`, `origem=convite`, `criado_em`,
   `atualizado_em`, `convite_enviado_em`.
4. Se o usuário já existe, não recria nem sobrescreve o saldo; avisa que o convite não foi
   reenviado.

Por que dispensa painel, tabela de convites e rota pública de aceite:

- a conta nunca é criada pelo cliente, então `AllowAdminCreateUserOnly` continua valendo e
  a API do Cognito segue recusando autocadastro;
- não há token de convite para vazar, expirar ou sofrer replay;
- nenhuma senha é gerada, lida ou gravada pelo script: o Cognito gera e envia.

Pontos de atenção:

- O e-mail sai pelo remetente padrão do Cognito (`no-reply@verificationemail.com`), com
  limite diário de ~50 mensagens por pool. Para o instrutor basta um envio.
- O script precisa de permissões de admin no Cognito e `PutItem`/`GetItem` em `Usuarios`.
  Rodando via perfil SSO, isso sai do próprio usuário.
- O convite pelo console do Cognito continua suportado: o template está no IaC e o registro
  em `Usuarios` é criado no primeiro acesso (`origem=lazy`).
- Se no futuro for exigido "o usuário escolhe a senha no link", aí sim entra o desenho com
  tabela de convites + endpoint público de aceite (versão anterior deste documento).

Arquivos: `scripts/invite-user.sh`, `scripts/set-limit.sh`, `package.json`,
`infra/lib/api-stack.ts`, `infra/lib/tools-stack.ts`, `api/index.ts`,
`tools/realizar_compra/index.ts`, `README.md`, `docs/TODO.md` e `docs/MODELO-USUARIOS.md`.

### 3.1 Persistência de usuários e conversas (obrigatória pelo PDF)

O PDF exige `Usuarios` (sub + limite disponível) e `Conversas` (histórico por usuário),
além de `Intencoes`. Estado verificado em 2026-11-17 na conta:

| Tabela | Itens | Quem escreve hoje |
|---|---|---|
| `luiz-henrique-usuarios` | 0 | ninguém |
| `luiz-henrique-conversas` | 0 | ninguém |
| `luiz-henrique-intencoes` | 1 | `registrar_intencao` (teste) |
| `luiz-henrique-catalogo` | 8 | seed do CDK |

Plano mínimo:

- `Usuarios`: criado pelo `invite-user.sh` (passo 4 acima). `realizar_compra` deixa de usar
  o fallback `LIMITE_COMPRA=500` e passa a exigir o registro; ausência de registro vira erro
  explícito (`USUARIO_NAO_ENCONTRADO`), não limite implícito.
- `Conversas`: a **Lambda do chat** grava o turno (usuário + resposta) por
  `usuario_id`/`conversa_id`, com append atômico (`list_append`) e `conversa_id` gerado no
  backend; é a única camada com permissão na tabela (o runtime do agente continua sem
  acesso direto, como o PDF exige).
- `GET /conversas`: nova rota no API Gateway com o mesmo autorizador, consultando o GSI
  `usuario_id-index` e retornando só as conversas do `sub` do token.
- CORS precisa incluir `GET` além de `POST/OPTIONS`.

### 3.2 Limite de gasto: modelo e CLI (decisão)

Modelo detalhado da tabela, chaves e padrões de acesso: `docs/MODELO-USUARIOS.md`.

Decisão: o limite é **saldo disponível**, gravado em `Usuarios` no momento da criação do
usuário, consumido a cada compra e ajustável por CLI.

- Item em `Usuarios`: `usuario_id` (PK = `sub`), `email`, `limite_centavos` (saldo
  disponível, inteiro), `status`, `origem`, `criado_em`, `atualizado_em`.
- Criação: `scripts/invite-user.sh <email> [limite]` grava o saldo inicial (default
  documentado, ex. 500).
- Consumo: `realizar_compra` faz a baixa atômica do saldo e o pagamento da intenção em uma
  única `TransactWriteItems`, com duas condições:
  - `Usuarios`: `limite_centavos >= :valor` e `SET limite_centavos = limite_centavos - :valor`;
  - `Intencoes`: `status = pendente` e `SET status = paga`.
  Se a condição do saldo falhar → `LIMITE_EXCEDIDO`; se a da intenção falhar →
  `INTENCAO_JA_PAGA`; intenção inexistente → `INTENCAO_INVALIDA`. Nada é debitado se
  qualquer condição falhar (sem saldo negado pela metade).
- Valores monetários: guardar em **centavos (inteiro)** para evitar erro de ponto
  flutuante; converter para reais só na resposta ao usuário. O código atual usa `Number`
  com decimais e precisa ser ajustado junto com esta mudança.
- Ajuste manual: `npm run user:set-limit -- <email|sub> <valor>` e
  `npm run user:reset-limit -- <email>` (`scripts/set-limit.sh`):
  1. resolve o `sub` com `admin-get-user` quando o argumento é e-mail;
  2. `update-item` em `Usuarios` com `SET limite_centavos = :valor, atualizado_em = :agora`;
  3. imprime o saldo anterior e o novo;
  4. falha com mensagem clara se o usuário não existe no Cognito ou não tem registro na
     tabela.
- O saldo é sempre o da tabela; nunca vem do modelo nem do corpo da requisição.
- Efeito colateral documentado: duas compras simultâneas não podem estourar o saldo, porque
  a condição é avaliada na transação; retries não debitam duas vezes porque a intenção só
  transita `pendente → paga` uma vez.

## 4. Auditoria de sincronização dos docs

Nenhum doc foi alterado nesta auditoria; a tabela abaixo é o relatório.

### README.md

| Linha/trecho | Problema | Correção sugerida |
|---|---|---|
| L27 diagrama "Amplify Hosting" | Não existe app Amplify nem stack de frontend | Corrigido: diagrama agora mostra frontend local |
| L30 "streaming/WebSocket" | API é REST não-streaming (`api-stack.ts:80`) | Corrigido: menção removida |
| L39 `aws login` / `aws sso login` | `login sso.md` diz explicitamente que `aws login` não autentica no Identity Center | Corrigido: agora só `aws sso login` |
| L57-59 "valores ficam apenas no `.env`" | O fluxo real (`scripts/dev-frontend-local.sh`) lê só `infra/cdk-outputs.json` | Corrigir a fonte |
| L123 `Conversas` com histórico | Nada grava conversas | Pendente: documentado como próxima etapa |
| L131 "Lambda do chat ... + leitura DynamoDB" | Role só tem `InvokeAgentRuntime` (`api-stack.ts:70-78`) | Corrigido: IAM detalhado por role |
| L135 Amplify Hosting | Recurso inexistente | Corrigido: removido |
| L157-166 remoção de app Amplify | Recurso inexistente | Corrigido: remoção simplificada |
| L118-126 modelagem | Omite `Catalogo` | Corrigido: modelagem completa no README |
| L176-177 "manter no ar" + instrutor | Incompatível com frontend local e sem convite | Reenquadrar em "Desvio desta entrega" |

### docs/TODO.md

| Linha/trecho | Problema | Correção sugerida |
|---|---|---|
| L38, L58, L108 `CfnAgentRuntime`/`CfnResource` | Código usa `cdk.CustomResource` (`agent-stack.ts:199`) | Corrigir os três pontos |
| L49 deploy "cria ... e frontend" | Não cria frontend | Remover "frontend" |
| L66 CORS "(Amplify)" | Origem é `http://localhost:3000` | Corrigir |
| L74 `config.json` "publicado no deploy" | Gerado por `scripts/dev-frontend-local.sh` | Corrigir |
| L94 `scripts/deploy-frontend.sh` | Arquivo não existe | Remover |
| L100 `[x]` Amplify Hosting | Falso | Marcar como não aplicável |
| L103 IAM S3/CloudFront | Recursos não existem | Remover |
| L106 VPC + security group | Não há VPC no código | Remover |
| L102/L68 instrutor | Script cria `TEST_EMAIL` e não grava em `Usuarios` | Substituir pelo fluxo de convite |
| L118 `401` pendente | Já verificado em `deploy-findings.md` | Marcar `[x]` |
| L22 "diagrama no TODO.md **ou** README" | Item é válido via README; o texto sugere que falta algo no TODO | Marcar `[x]` e apontar o README |
| L33 tratamento de erros `[x]` | As tools retornam erro textual, mas não os códigos da Fase 1 exigidos pelo PDF | Reabrir como item de contrato de erro |
| L75 vs L93 build estático duplicado | Dois itens iguais, um marcado e outro não | Consolidar |

### docs/STACK.md

- L11-13 cita S3/CloudFront no CDK; nenhum dos dois é criado.
- L33 lista `conversas` como persistidas; só a tabela existe.
- L27 diz que usuários entram por convite sem registrar que o envio do convite não existe.

### docs/deploy-findings.md

- L57 diz "contract implemented ... (`requestSchema`)" mas L23-27 registram a remoção do
  schema — contradição interna.
- L76 fala "live version 3" enquanto L146 e P2 falam runtime v5 — versões inconsistentes.
- P4 (frontend local) e P5 (divergências do TODO) continuam válidos e são a base de parte
  desta auditoria.

### docs/destroy-cleanup.md

- L97-106 lista `resources-*.json` e `orphans-*.md` como arquivos criados, mas eles estão
  em `logs/` (gitignorado), não em `docs/`.
- L24-26 "Required Fix: add to Destroy Script" está obsoleto: `scripts/destroy-cleanup.sh`
  já existe e `npm run destroy` já o executa.

### docs/MIGRACAO-ANTERIOR.md

- L31 mapeia o frontend para "S3 + CloudFront"; hoje é local.

### docs/ROADMAP.md

- §3 (painel admin) não inclui o convite por e-mail, que virou escopo desta rodada.
- §4 discute limite por compra; o PDF fala em "limite de gasto disponível" por usuário —
  a decisão continua aberta.

### docs/PLANO-CHAT.md

- L7 e §6 registram corretamente que a API não faz streaming; é o conflito direto com o
  requisito "Stream ou WebSocket" do PDF, não um erro do doc.

### docs/ISSUES-LOGIN.md

- Em sincronia: `hideSignUp` continua ausente (`frontend/app/page.tsx:45`) e o tema do
  `Authenticator` segue sem `ThemeProvider`.

### docs/PLANO-USER-MENU.md

- Em sincronia com o código atual.

### AGENTS.md

- §4 e §7 afirmam "bucket S3 privado servido só pelo CloudFront (OAC)" e "hospedagem S3 +
  CloudFront", contradizendo o frontend local adotado.
- §1 não lista `scripts/`, `tests/` e `logs/`, que existem na pasta.

### README.md da raiz do repositório (fora da pasta do fellow)

- Usa `Desafio-1/<seu-nome>/`; o PDF usa `fellows/<seu-nome>/`. Divergência de convenção —
  requer decisão do time, não correção local.

## 5. Decisões pendentes

1. ~~Convite: token próprio + SES ou e-mail nativo do Cognito~~ — decidido: script CLI com
   senha temporária + SES (§3).
2. ~~Limite do convite: acumulado ou por compra~~ — decidido: saldo disponível por usuário,
   gravado na criação, consumido na compra e ajustável por CLI (§3.2).
3. ~~Painel admin ou CLI~~ — decidido: CLI (`npm run user:invite`). Painel admin fica no
   roadmap.
4. Endurecer agora os gaps de spec (`GET /conversas` + persistência de conversas,
   streaming, códigos de erro das tools, checagem de dono/expiração da intenção) ou só o
   fluxo de convite e a persistência de usuários/conversas nesta rodada?
5. Registrar o desvio do frontend local como seção própria no README da entrega?
