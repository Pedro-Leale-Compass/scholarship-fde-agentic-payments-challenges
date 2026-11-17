# tools/

As três ferramentas do agente como **AWS Lambda em TypeScript** (Node 22, arm64): consultar o catálogo, registrar a intenção de compra e realizar o pagamento simulado.

```bash
npm ci
npm test         # vitest, com o DynamoDB mockado (não acessa a AWS)
npm run typecheck
npm run build    # gera infra/build/tools/<tool>/index.mjs (esbuild)
```

## Evento

Quem invoca é só o agente no AgentCore Runtime:

```json
{ "usuario_id": "<sub do Cognito>", "argumentos": { "...": "o que o modelo preencheu" } }
```

O `usuario_id` é injetado pelo código do agente a partir da sessão autenticada. Um `usuario_id` dentro de `argumentos` é ignorado. A Lambda devolve o JSON do contrato diretamente, seja o sucesso ou a recusa `{ status: "recusado", erro, mensagem }`.

## Tools

| Lambda | Contrato | Tabelas (role) |
|---|---|---|
| [`listar_catalogo`](src/listar-catalogo.ts) | `{ categoria? }` → `{ produtos: [{ id, nome, preco, moeda, estoque }] }` | `produtos`: Scan |
| [`registrar_intencao`](src/registrar-intencao.ts) | `{ produto_id, quantidade }` → `{ intencao_id, produto_id, quantidade, valor_total, moeda, status: "pendente", expira_em }` | `produtos`: GetItem · `intencoes`: PutItem |
| [`realizar_compra`](src/realizar-compra.ts) | `{ intencao_id, metodo_pagamento }` → `{ status: "aprovado", transacao_id, intencao_id, valor, metodo_pagamento, limite_restante, data }` | `intencoes`: Get/Update · `usuarios`: Get/Put/Update · `produtos`: Get/Update · `transacoes`: Put |

## Como a compra evita duplicidade

`realizar_compra` faz pré-checagens para devolver a mensagem certa e grava tudo num único `TransactWriteItems`, tudo ou nada:

| # | Item | Condição |
|---|---|---|
| 0 | intenção → `paga` | `usuario_id = :usuario AND status = pendente AND expira_em > agora` |
| 1 | usuário: `limite_disponivel_centavos -= valor` | `limite_disponivel_centavos >= valor` |
| 2 | produto: `estoque -= quantidade` | `estoque >= quantidade` |
| 3 | transação (PK `intencao_id`) | `attribute_not_exists(intencao_id)` |

Se a mesma chamada chegar duas vezes, a segunda falha nas condições 0 e 3, nada é descontado e a resposta é `INTENCAO_JA_PAGA`. O motivo do cancelamento (`CancellationReasons`) é traduzido para `INTENCAO_JA_PAGA`, `INTENCAO_EXPIRADA`, `LIMITE_EXCEDIDO` ou `ESTOQUE_INSUFICIENTE`.

O valor vem sempre da intenção gravada. Qualquer `valor` enviado pelo modelo é ignorado.

## Erros

Toda recusa tem o formato `{ "status": "recusado", "erro": "<CÓDIGO>", "mensagem": "<texto que o agente explica ao usuário>" }`.

| Situação | Código | Tool |
|---|---|---|
| Chamada sem `usuario_id` no evento | `INTENCAO_INVALIDA` | `registrar_intencao`, `realizar_compra` |
| `produto_id` inexistente ou inventado | `PRODUTO_NAO_ENCONTRADO` | `registrar_intencao` |
| Quantidade zero, negativa ou fracionada | `QUANTIDADE_INVALIDA` | `registrar_intencao` |
| Quantidade acima do estoque (no registro ou no pagamento) | `ESTOQUE_INSUFICIENTE` | `registrar_intencao`, `realizar_compra` |
| `intencao_id` inexistente, inventado ou de outro usuário | `INTENCAO_INVALIDA` | `realizar_compra` |
| Intenção já paga, inclusive em chamada repetida ou simultânea | `INTENCAO_JA_PAGA` | `realizar_compra` |
| Intenção depois dos 15 minutos | `INTENCAO_EXPIRADA` | `realizar_compra` |
| Valor acima do limite disponível | `LIMITE_EXCEDIDO` | `realizar_compra` |
| Método diferente de `cartao` ou `pix` | `METODO_INVALIDO` | `realizar_compra` |
| Falha interna (DynamoDB fora, erro inesperado) | `FALHA_NA_FERRAMENTA` | todas |

- **Validação na própria Lambda:** argumentos inválidos (como quantidade zero ou fracionada) viram uma recusa no formato padrão, mesmo que o modelo os envie. A Lambda é a última linha de defesa.
- **`FALHA_NA_FERRAMENTA`:** qualquer exceção inesperada vira mensagem amigável. O detalhe técnico vai só para o CloudWatch Logs, nunca para o usuário.
