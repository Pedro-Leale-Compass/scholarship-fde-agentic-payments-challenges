# Persistência de pagamentos

## Estrutura

Stack independente: `paulo-antonio-pagamentos-dados`, região `us-east-1`. Quatro tabelas com capacidade sob demanda, criptografia padrão DynamoDB e sem índices secundários:

| Tabela | Chave | Conteúdo |
|---|---|---|
| `paulo-antonio-pagamentos-usuarios` | `userId` | Identificador confiável, `limit` e `spent` em centavos |
| `paulo-antonio-pagamentos-intencoes` | `id` | Titular, SKU, quantidade, valor em centavos, prazo em milissegundos e estado |
| `paulo-antonio-pagamentos-transacoes` | `id` | Titular, identificador da tentativa e resultado aprovado |
| `paulo-antonio-pagamentos-conversas` | `userId` + `conversationId` | Histórico completo, título, confirmação pendente, versão e controle temporário de execução |

Não há TTL: o vencimento é validado na compra, e a remoção automática de uma intenção paga não deve apagar a evidência de duplicidade. Dados de demonstração reais permanecem até a limpeza combinada. As quatro tabelas usam `RemovalPolicy.DESTROY`; excluir a stack de dados apaga todos os registros. Preservar evidências antes de remover. A tabela de conversas é acessada pelas Lambdas de chat/histórico; o runtime não possui acesso direto. Veja `../agent/README.md` para limites e condições de gravação.

## Garantia de pagamento

`tools/src/dynamo-store.ts` implementa `PaymentStore` usando o SDK oficial. Valores são inteiros em centavos. A compra lê os registros e submete uma transação com três operações condicionais:

1. Atualizar gasto somente se limite e gasto ainda forem os mesmos da leitura. O novo gasto é calculado após validar saldo disponível.
2. Marcar a intenção como paga somente se pertencer ao usuário, estiver pendente, tiver o valor esperado e prazo posterior ao instante da tentativa.
3. Inserir registro único da transação, identificado deterministicamente pela intenção.

As três operações são confirmadas ou canceladas juntas. Conflitos temporários e condições que mudaram provocam releitura, nova verificação de prazo/saldo e repetição limitada com atraso. Uma segunda chamada após pagamento retorna `INTENCAO_JA_PAGA`; não cria nova transação. Cada tentativa usa um `ClientRequestToken` estável para repetições do SDK. Se uma resposta se perder após a gravação, só se recupera como sucesso o registro da mesma tentativa; erros de infraestrutura não são convertidos em recusa de negócio.

O prazo usa o relógio do backend no início de cada tentativa, inclusive na condição da transação; não depende do relógio do navegador nem da remoção eventual por TTL. A criação de intenções também trata conflitos temporários entre verificações do mesmo usuário.

Referências: [transações DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html) e [TransactWriteItems](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html).

## Identidade e provisionamento

`ensureUser` é uma operação interna de provisionamento, não uma ferramenta exposta ao modelo. O padrão adotado para o futuro usuário Cognito é R$ 5.000 de limite simulado. A inserção condicional nunca restaura gasto nem muda o limite de um registro existente. Um valor diferente é permitido apenas ao código de provisionamento/teste, não aos argumentos do usuário ou do modelo.

Atualização de 16/11/2026: o adaptador está ligado à Lambda de ferramentas, que usa o `sub` validado pelo autorizador Cognito ou o contexto confiável do AgentCore. A conta é provisionada condicionalmente no primeiro acesso a `/conta` ou criação de intenção. A função possui permissões de leitura/escrita restritas às três tabelas de pagamentos, sem scan/exclusão; a Lambda de sessão continua sem acesso a dados. A integração com o agente passou na AWS. Consulte `API-PAGAMENTOS.md` e `EVIDENCIAS-E-ENTREGA.md`.

## Deploy e testes

Validação em 15/11/2026: stack de dados criada com sucesso; 16 testes locais de ferramentas, oito de infraestrutura/sessão e oito verificações de integração DynamoDB passaram. Compilação TypeScript passou e a auditoria das dependências de produção de `tools` retornou zero vulnerabilidades conhecidas. Os fixtures foram removidos ao final. A primeira rodada revelou conflito temporário na criação paralela de intenções; após implementar repetição controlada, toda a rodada passou.

O comando habitual `infra/scripts/deploy.mjs` agora publica a stack de dados antes da stack da aplicação. Outputs separados em `.deploy/data-outputs.json`. Para publicar apenas os dados após o build, na pasta `infra`:

```powershell
pnpm exec cdk deploy paulo-antonio-pagamentos-dados --profile desafio-1 --context prefix=paulo-antonio --context backendOnly=true --outputs-file ../.deploy/data-outputs.json
```

Na pasta `tools`, instalar dependências com `pnpm install --frozen-lockfile --store-dir ../.pnpm-store`. Os testes locais são `node --test test/*.test.ts`. A demonstração em `src/demo.ts` continua isolada em memória.

Teste explícito no DynamoDB real, com SSO ativo e conta conferida:

```powershell
node test/dynamo.integration.ts --account CONTA_DE_12_DIGITOS
```

O teste usa somente usuários `integration-<UUID>`, nunca um usuário Cognito. Verifica persistência entre clientes independentes, provisionamento idempotente, Pix, cartão, titularidade, método inválido, vencimento, débito duplicado e corrida pelo saldo. Espera todas as operações concorrentes terminarem antes da limpeza. Apaga apenas as chaves fictícias geradas naquela execução; não apaga tabelas, não limpa usuários reais. A execução consome pequenas quantidades de leituras/escritas. Não deve ser usada como teste de carga.
