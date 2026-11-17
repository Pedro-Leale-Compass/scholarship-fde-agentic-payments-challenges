# Modelo da tabela `Usuarios` (DynamoDB) alinhado a Cognito/Amplify

Objetivo: registrar todo usuário autenticado com seu saldo de gasto disponível, usando a
identidade estável do Cognito. Base para as tools de compra, para o `GET /conversas` e para
o ajuste de limite por CLI.

## 1. Identidade: qual chave usar

| Candidato | Problema | Decisão |
|---|---|---|
| `email` | mutável no Cognito e pode ser reusado por outra pessoa | nunca como chave |
| `cognito:username` | com alias de e-mail costuma ser o próprio e-mail; também mutável | nunca como chave |
| `sub` | UUID imutável gerado pelo Cognito, presente no ID/access token | **PK** |

- O frontend (Amplify) obtém o token com `fetchAuthSession()` e envia
  `Authorization: Bearer <IdToken>`.
- O backend lê o `sub` de `requestContext.authorizer.claims.sub`
  (`infra/lib/api-stack.ts` já usa o authorizer Cognito). Nunca do corpo nem do modelo.
- `email`, `nome` e afins são **atributos denormalizados** para exibição/administração,
  não identificadores.

## 2. Estrutura do item

Tabela: `luiz-henrique-usuarios` (já criada em `infra/lib/database-stack.ts:21`).

| Atributo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `usuario_id` | S | sim | PK = `sub` do Cognito |
| `email` | S | sim | e-mail do Cognito, para exibição e busca no admin |
| `nome` | S | não | nome do Cognito (`name`/`given_name`), se existir |
| `limite_centavos` | N | sim | **saldo disponível** em centavos (inteiro) |
| `gasto_total_centavos` | N | não | acumulado pago, só para relatório (derivável de `Intencoes`) |
| `status` | S | sim | `ativo` ou `bloqueado` (bloqueio sem apagar o usuário do Cognito) |
| `origem` | S | sim | `convite`, `console` ou `lazy` (primeiro acesso) |
| `criado_em` | S | sim | ISO-8601 UTC |
| `atualizado_em` | S | sim | ISO-8601 UTC, atualizado em toda escrita |
| `convite_enviado_em` | S | não | auditoria do envio por SES |
| `ultima_intencao_id` | S | não | último `intencao_id` do usuário, usado pelo chat para não depender da memória do modelo |

Nunca gravar: senha, senha temporária, tokens, `refreshToken`, códigos de verificação ou
qualquer segredo. O Cognito é a fonte de verdade de credenciais.

Exemplo:

```json
{
  "usuario_id": "04b8e478-1f3c-4b1e-9a6e-8f0f2c9b7a11",
  "email": "luiz.fsilva@fellowship.aircompany.ai",
  "nome": "Luiz Henrique",
  "limite_centavos": 50000,
  "gasto_total_centavos": 0,
  "status": "ativo",
  "origem": "convite",
  "criado_em": "2026-11-17T14:40:00Z",
  "atualizado_em": "2026-11-17T14:40:00Z",
  "convite_enviado_em": "2026-11-17T14:40:00Z"
}
```

## 3. Chaves e índices

- PK: `usuario_id` (S). Sem SK.
- Sem GSI nesta rodada. Todos os acessos são por `sub`, e a busca por e-mail é resolvida no
  Cognito (`admin-get-user`), que é a fonte de verdade.
- Se o painel admin precisar listar/filtrar usuários, aí sim entra um GSI
  `status-index` ou uma tabela de índice — fora do escopo atual; com poucos usuários, um
  `Scan` do script admin é aceitável (documentado como limitação).

## 4. Padrões de acesso

| # | Operação | Como |
|---|---|---|
| 1 | Ler perfil/saldo do usuário logado | `GetItem` por `sub` |
| 2 | Criar usuário no convite | `PutItem` com `attribute_not_exists(usuario_id)` |
| 3 | Garantir registro no primeiro acesso | `PutItem` condicional (upsert lazy, só se ausente) |
| 4 | Debitar saldo + pagar intenção | `TransactWriteItems`: `Update` em `Usuarios` (`limite_centavos >= :valor`, `SET limite_centavos = limite_centavos - :valor`) + `Update` em `Intencoes` (`status = pendente`) |
| 5 | Definir/zerar saldo (CLI) | `UpdateItem` `SET limite_centavos = :valor, atualizado_em = :agora` |
| 6 | Bloquear usuário (futuro) | `UpdateItem` `SET status = bloqueado`; tools recusam com `USUARIO_BLOQUEADO` |

Regras:

- Dinheiro sempre em centavos inteiros; conversão para R$ só na resposta ao usuário.
- A baixa do saldo e o pagamento da intenção são atômicos (uma transação). Se qualquer
  condição falhar, nada é debitado.
- Retry não debita duas vezes: a intenção só sai de `pendente` uma vez.
  `ClientRequestToken` no `TransactWriteItems` foi **removido de propósito**: reaproveitar o
  token com parâmetros diferentes (ex.: mudar a forma de pagamento) faz o DynamoDB recusar
  com `IdempotentParameterMismatchException`; as condições `pendente` + `limite >= valor`
  já garantem a idempotência correta.
- Saldo nunca vem do modelo, do corpo da requisição nem do frontend.
- Saldo não pode ficar negativo: a condição `limite_centavos >= :valor` garante isso.

## 5. Limite: criação, consumo e ajuste

- **Criação** (`scripts/invite-user.sh`): `admin-create-user` sem `SUPPRESS`, então o próprio
  Cognito envia o convite com a senha temporária (template configurado no CDK em
  `userInvitation`). Depois lê o `sub` com `admin-get-user` e grava o item com saldo inicial
  padrão de `50000` centavos (R$ 500,00), sobrescrevível por argumento.
- **Fallback de primeiro acesso**: se um usuário autenticado não tiver item (criado pelo
  console do Cognito, por exemplo), a Lambda cria com o saldo padrão e `origem=lazy`.
  Isso garante que a tabela reflita todos os usuários logados.
- **Consumo**: `realizar_compra` (ver §4, linha 4). O fallback `LIMITE_COMPRA=500` do
  código atual é removido: quem não tem registro ganha o registro lazy, não um limite
  implícito.
- **Ajuste** (`scripts/set-limit.sh`):
  - `npm run user:set-limit -- <email|sub> <valor_em_reais>`
  - `npm run user:reset-limit -- <email>`
  - lê antes/depois e imprime os dois saldos; falha se o usuário não existir.

## 6. Alinhamento com Cognito/Amplify

- User Pool: `selfSignUpEnabled: false` (`infra/lib/api-stack.ts:34`),
  `signInAliases: { email: true }`, `autoVerify: { email: true }`.
- Claims usados pelo backend: `sub` (PK), `email` (atributo), `cognito:username`
  (ignorado para identidade), `cognito:groups` (futuro `admins`).
- O frontend não acessa DynamoDB diretamente (sem Amplify Data/GraphQL): continua falando
  só com o API Gateway, como o PDF exige.
- A tela de login usa `Authenticator hideSignUp`; o cadastro é feito pelo script/SES.
- Primeiro login com senha temporária: Cognito exige `NEW_PASSWORD_REQUIRED`; o Amplify
  `Authenticator` já trata esse estado e pede a nova senha.
- E-mail trocado no Cognito não quebra a identidade: o `sub` permanece; só o atributo
  `email` precisa ser sincronizado (script ou lazy upsert).

## 7. Migração e impacto

- A tabela atual já tem PK `usuario_id` (`infra/lib/database-stack.ts:21-27`), então
  **nenhuma mudança destrutiva de chave** é necessária.
- Itens de teste existentes: a tabela está vazia (verificado em 2026-11-17); não há
  migração de dados.
- Campos novos convivem com o schema atual; `limite` (nome antigo) deixa de ser lido
  quando `realizar_compra` for ajustado.
- IAM: a Lambda do chat ganha `dynamodb:GetItem`/`PutItem`/`UpdateItem` **somente** em
  `Usuarios`; as tools de compra ganham `UpdateItem` em `Usuarios` e `Intencoes` +
  `dynamodb:TransactWriteItems` restrito às duas tabelas. Sem curinga.

## 8. Checklist de implementação

- [x] `scripts/invite-user.sh` (Cognito + `PutItem`, convite por e-mail do Cognito) e
      aliases no `package.json`.
- [x] `scripts/set-limit.sh` (`user:set-limit`, `user:reset-limit`).
- [x] Lazy upsert na Lambda do chat (com IAM mínimo) — `origem=lazy`.
- [x] `realizar_compra` sem fallback + `TransactWriteItems`.
- [x] `valor_centavos` e `expira_em` na intenção; saldo e débito em centavos.
- [x] README: modelagem da tabela, campos, CLI e aviso de que senha nunca é gravada.
- [ ] Evidência: item na tabela após convite, saldo antes/depois de compra, CLI ajustando
      saldo.
- [ ] Conversas: persistência e `GET /conversas` (próxima etapa).
- [ ] `GET /me` para o frontend exibir o saldo.
