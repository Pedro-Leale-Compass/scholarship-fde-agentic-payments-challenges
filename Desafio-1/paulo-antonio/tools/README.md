# Ferramentas de pagamentos — execução local

Atualização de 16/11/2026: as ferramentas também estão publicadas em Lambda e acessíveis pela interface local autenticada. `demo.ts` continua usando memória. Consulte `../docs/API-PAGAMENTOS.md` para rotas, permissões, teste da função e roteiro manual. Agora são 20 testes locais das ferramentas/handler.

As três ferramentas estão implementadas como funções TypeScript em `src/payments.ts`, sem dependências de execução externas. A base antiga em `ollama-tools/` permanece como referência e não recebe essas correções automaticamente.

Requer Node.js 24 (versão usada: 24.22.1). Para todos os testes, instale as dependências com `pnpm install --frozen-lockfile --store-dir ../.pnpm-store`. Na pasta `tools`, execute:

```powershell
node --test test/*.test.ts
```

Demonstração automática: catálogo, intenção de PS5, Pix aprovado e segunda cobrança recusada:

```powershell
node src/demo.ts
```

Para testar manualmente:

```powershell
node src/demo.ts --interativo
```

Digite um comando por vez:

```text
catalogo
intencao MONITOR 1
comprar pix
comprar pix
intencao PCGAMER 1
comprar cartao
sair
```

O primeiro pagamento aprova R$ 1.899,90, restando R$ 3.100,10. Repetir recusa com `INTENCAO_JA_PAGA`. O PC Gamer recusa com `LIMITE_EXCEDIDO`. `intencao PS5 0` e quantidades fracionárias são rejeitadas. Para testar expiração manual, crie uma intenção e aguarde três minutos antes de pagar. Os testes automatizados usam relógio controlado, sem esperar.

A demonstração cria explicitamente um participante fictício com limite de R$ 5.000. Não é fallback das ferramentas nem usuário Cognito. Reiniciar apaga os dados e restaura o limite. Não há conexão AWS, pagamento real, MCP, agente ou integração com a interface web nesta etapa.

## Contratos e identidade

| Função | Argumentos da ferramenta | Contexto separado |
|---|---|---|
| `listar_catalogo` | `categoria` opcional | — |
| `registrar_intencao` | `sku`, `quantidade` | `{ usuario_id }` obrigatório |
| `realizar_compra` | `intencao_id`, `metodo_pagamento` | `{ usuario_id }` obrigatório |

O futuro adaptador deve construir o contexto exclusivamente a partir da identidade autenticada e propagada pelo backend. A biblioteca não valida JWTs. Não expor o contexto como argumento do modelo nem aceitar identidade enviada pelo navegador sem autenticação. Campos extras de identidade, preço ou ID nos argumentos não substituem os dados confiáveis.

O catálogo preserva os seis produtos e preços da primeira fase. Categoria desconhecida gera `BadArgs`, como na base. Intenção exige quantidade inteira positiva e SKU conhecido. Valores internos são inteiros em centavos; o retorno mantém valores em reais. Totais fora do intervalo inteiro seguro são recusados. IDs usam UUID completo. Validade de 180 segundos; no instante exato do vencimento a intenção já expirou.

Compra mantém o contrato `aprovado`/`recusado` e os cinco erros documentados no guia. Intenções inexistentes e de outro usuário recebem a mesma mensagem. Recusas não alteram limite, intenção nem transações. Métodos aceitos: cartão (`cartao`) e Pix (`pix`), ambos simulados.

## Armazenamento e próxima etapa

`MemoryPaymentStore` guarda usuários, intenções e transações somente em memória. A validação e as três atualizações da compra ocorrem sem suspensão dentro de um processo Node. Os testes com chamadas simultâneas comprovam apenas essa propriedade local, não concorrência entre processos, instâncias Lambda ou resistência a reinício.

`DynamoPaymentStore` já implementa `settle` atomicamente no DynamoDB e passou nos testes reais de concorrência. `demo.ts` continua usando memória. Consulte [persistência DynamoDB](../docs/DYNAMODB.md). O provisionamento ainda deve ser ligado à identidade Cognito autenticada; nenhum limite é concedido por argumentos do modelo.

## Verificação realizada em 15/11/2026

16 testes locais: 13 das regras de negócio e três sobre falhas/repetições do adaptador DynamoDB. Oito verificações adicionais passaram no DynamoDB real, incluindo persistência e concorrência. A demonstração local continua funcionando sem dependências externas; os testes completos agora incluem o SDK AWS.

Verificação TypeScript reutiliza o compilador já instalado em `infra`:

```powershell
node ../infra/node_modules/typescript/bin/tsc -p tsconfig.json
```

Para instalar esse compilador em outro checkout, siga a instalação de dependências em `infra/README.md`. A execução direta dos testes usa Node.js e as dependências de `tools`; não precisa do compilador. A demonstração em memória precisa somente do Node.js.
