# Ferramentas de pagamento

Este pacote porta para TypeScript as três ferramentas do chatbot da Fase 1:
`listar_catalogo`, `registrar_intencao` e `realizar_compra`. Preserva o formato
de resposta e as regras existentes, substituindo SQLite por DynamoDB. As
funções são empacotadas como Lambdas pela stack e chamadas pelo agente Strands
no Bedrock AgentCore.

## Regras preservadas

- Preços e limites são calculados em centavos no backend.
- Intenções pertencem ao `sub` do usuário Cognito e ao UUID v4 da conversa,
  expiram em cinco minutos e não reservam estoque.
- O limite inicial de usuários novos é de R$ 1.000,00 (100000 centavos),
  mantido como `limite_cents` e `limite_restante_cents` no item do usuário. O
  perfil é provisionado no primeiro acesso autenticado ao chat (e garantido de
  forma idempotente pelas tools, se necessário).
- Compra valida intenção, proprietário, conversa, expiração, método, limite e
  estoque. As atualizações de intenção, limite, estoque e registro de transação
  ocorrem em uma única transação condicional DynamoDB.
- As Lambdas das ferramentas não acessam a tabela de conversas. Seus eventos
  retornam pelo AgentCore e são persistidos pela Lambda do chat, que tem
  permissão de escrita restrita à tabela.
- O contexto autenticado (`userId` e `conversaId`) é separado dos argumentos
  fornecidos pelo modelo. O runtime Strands recebe o `sub` validado pelo
  Cognito da Lambda de chat e o injeta nas chamadas; nunca aceite `userId` dos
  argumentos da ferramenta.

O catálogo inicial está em `src/catalog.ts` e corresponde aos cinco produtos
do chatbot anterior. Não são migrados dados de usuários, conversas ou compras
do SQLite.

## Validar localmente

Na pasta `tools/`, execute:

```powershell
npm ci
npm run check
```

Os testes usam um armazenamento em memória e mocks do SDK; não acessam a AWS.

Após deploy autorizado da stack, configure `PRODUCTS_TABLE` como
`AlanLorenz-Produtos` e execute `npm run seed:catalog` para inserir o catálogo.
No PowerShell, na pasta `tools/`:

```powershell
$env:PRODUCTS_TABLE = 'AlanLorenz-Produtos'
npm run seed:catalog
```

O comando usa as credenciais AWS ativas, grava no DynamoDB sem sobrescrever
produtos existentes e não faz parte da validação local.
