# Modelo de dados — DynamoDB

Verificado contra `infra/lib/database-stack.ts` e nas tools em **2026-11-17**.

Tabelas prefixadas com `luiz-henrique`, billing on-demand, `RemovalPolicy.DESTROY` (o
`npm run destroy` remove tudo).

## 1. `Usuarios`

PK: `usuario_id` (= `sub` do Cognito). Sem SK.

| Atributo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `usuario_id` | S | sim | `sub` do Cognito; identidade imutável |
| `email` | S | sim | atributo de exibição/busca |
| `nome` | S | não | opcional |
| `limite_centavos` | N | sim | **saldo disponível** em centavos |
| `gasto_total_centavos` | N | não | acumulado pago (relatório) |
| `status` | S | sim | `ativo` ou `bloqueado` |
| `origem` | S | sim | `convite`, `console` ou `lazy` |
| `criado_em` / `atualizado_em` | S | sim | ISO-8601 UTC |
| `convite_enviado_em` | S | não | auditoria |
| `ultima_intencao_id` | S | não | **legado problemático**; ver §5 |

`ultima_intencao_id` é escrito pela Lambda do chat e lido em todo turno. Ele não é escopado
por conversa e não é invalidado quando a intenção vira `paga`/`cancelada`/`expirada`. É a
causa direta da reutilização de ID no transcript. O plano substitui isso por estado em
`Conversas`. Até a migração, **não confie nesse campo** para decidir pagamento.

## 2. `Conversas`

PK: `conversa_id` (S); SK: `usuario_id` (S). GSI `usuario_id-index`
(PK `usuario_id`, SK `conversa_id`).

Estado atual: a tabela existe, mas **nada grava ou lê** nela. O PDF exige histórico por
usuário; isso está pendente. O plano propõe usar esta tabela para o estado de checkout e,
se necessário, para o histórico de mensagens.

Item alvo (proposto):

```json
{
  "conversa_id": "uuid",
  "usuario_id": "sub",
  "pending_intencao_id": "INT-XXXXXXXX",
  "pending_status": "pendente",
  "updated_at": "2026-11-17T18:00:00Z"
}
```

Regras propostas:

- `pending_intencao_id` só é gravado após `registrar_intencao` retornar `ok: true`.
- É limpo em `paga`, `cancelada` ou `expirada`.
- É lido no início do turno só se a intenção ainda estiver `pendente` e não expirada.
- `conversa_id` deve vir do frontend (localStorage) ou ser criado no backend no primeiro
  turno e devolvido ao cliente.

## 3. `Intencoes`

PK: `intencao_id` (S). GSI `usuario_id-index` (PK `usuario_id`, SK `status`).

| Atributo | Tipo | Descrição |
|---|---|---|
| `intencao_id` | S | `INT-XXXXXXXX` |
| `usuario_id` | S | dono |
| `produtos` | L | lista de mapas `{ id, nome, preco }` (snapshot) |
| `valor` | N | total em reais |
| `valor_centavos` | N | total em centavos (fonte de verdade para débito) |
| `status` | S | `pendente`, `paga`, `cancelada` (o plano adiciona `expirada` explícito) |
| `created_at` | S | ISO-8601 |
| `expira_em` | S | ISO-8601; 15 minutos |
| `forma_pagamento` | S | `cartao`/`pix` quando paga |
| `pago_em` | S | ISO-8601 |
| `motivo_falha` | S | ex.: `LIMITE_EXCEDIDO`, `INTENCAO_EXPIRADA` |
| `cancelada_em` | S | ISO-8601 |

O plano adiciona `conversa_id` para rastrear a intenção até a conversa.

## 4. `Catalogo`

PK: `id` (S). Campos `nome` (S) e `preco` (N). Populado no deploy por
`AwsCustomResource` (`infra/lib/desafio-1-stack.ts`).

8 produtos: `p1` Fone Bluetooth (199,90), `p2` Teclado Mecânico (349,90), `p3` Mouse Gamer
(129,90), `p4` Monitor 27" (1.299,00), `p5` Webcam Full HD (299,00), `p6` Cadeira Gamer
(1.499,00), `p7` Headset com Microfone (249,90), `p8` Suporte para Monitor (149,00).

**Pendência:** `registrar_intencao` ainda aceita `nome`/`preco` do modelo. O plano é receber
só `produto_id`/`quantidade` e resolver o preço nesta tabela.

## 5. Padrões de acesso e regras

| Operação | Como |
|---|---|
| Ler perfil/saldo | `GetItem` por `usuario_id` |
| Criar usuário por convite | `PutItem` condicional `attribute_not_exists(usuario_id)` |
| Garantir usuário no 1º acesso | `PutItem` condicional, `origem=lazy` |
| Debitar saldo + pagar | `TransactWriteItems` em `Usuarios` e `Intencoes` |
| Ajustar saldo | `UpdateItem` via `scripts/set-limit.sh` |
| Registrar intenção | `PutItem` em `Intencoes` |

Regras:

- Dinheiro sempre em centavos inteiros.
- O débito e o pagamento são atômicos: se qualquer condição falhar, nada é debitado.
- `limite_centavos >= valor` impede saldo negativo.
- `status = pendente` impede pagamento duplo.
- `usuario_id` vem do `sub` do JWT, nunca do modelo/corpo.
- Preço e produto devem vir do backend, não do modelo (pendente).

## 6. CLI de usuários

```bash
npm run user:invite -- <email> [limite_em_reais]
npm run user:set-limit -- <email|sub> <limite_em_reais>
npm run user:reset-limit -- <email>
```

Scripts: `scripts/invite-user.sh`, `scripts/set-limit.sh`. O convite é enviado pelo próprio
Cognito (template `userInvitation`); nenhuma senha/token é gravado no DynamoDB.

## 7. Migração

- `ultima_intencao_id` permanece por compatibilidade, mas deixa de ser lido no fluxo novo.
- `Intencoes` existentes sem `conversa_id` continuam válidas; o estado novo só se aplica a
  conversas iniciadas após o deploy.
- Nenhuma mudança destrutiva de chave é necessária.
- `Conversas` pode começar vazia; o primeiro turno de cada conversa cria o item.
