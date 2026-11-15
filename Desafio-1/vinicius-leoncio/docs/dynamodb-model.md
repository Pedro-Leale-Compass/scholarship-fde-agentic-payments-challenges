# Persistência do Sprint 2

A implementação separa os dados de conversa dos dados de pagamento para que as roles possam ter permissões distintas.

## Tabela de pagamentos

Nome configurado por PAYMENTS_TABLE_NAME. Chaves de partição PK e ordenação SK.

| Registro | PK | SK | Campos principais |
|---|---|---|---|
| Perfil do usuário | USER#<cognito-sub> | PROFILE | limite disponível e data de criação |
| Intenção | USER#<cognito-sub> | INTENT#<id> | usuário, conversa, produto, quantidade, valor calculado, status e expiração |
| Transação | USER#<cognito-sub> | TRANSACTION#<id> | intenção, valor, método e data |
| Auditoria de ferramenta | USER#<cognito-sub> | AUDIT#<data>#<id> | ferramenta, parâmetros, resultado e conversa |
| Produto/catálogo | CATALOG | PRODUCT#<id> | catálogo oficial, preço e estoque restante |

As Lambdas das ferramentas acessam somente esta tabela. O estoque inicial é carregado com gravações condicionais na primeira chamada; chamadas futuras não restauram estoque já consumido.

## Tabela de conversas

Nome configurado por CONVERSATIONS_TABLE_NAME, também com PK e SK.

| Registro | PK | SK | Campos principais |
|---|---|---|---|
| Conversa | USER#<cognito-sub> | CONVERSATION#<uuid> | estado, versão e datas |
| Mensagem completa | USER#<cognito-sub> | CONVERSATION#<uuid>#MSG#<sequência> | mensagem Strands, incluindo chamadas e resultados de ferramentas |
| Mensagem exibida | USER#<cognito-sub> | CONVERSATION#<uuid>#DISPLAY#<sequência> | somente texto da conversa exibido ao usuário |

A Lambda do chat lê e grava somente esta tabela. O histórico é consultado em páginas até o fim e enviado integralmente ao agente em cada turno. Um bloqueio condicional impede duas requisições simultâneas de sobrescreverem o mesmo turno.

## Regras no pagamento

A função de compra busca a intenção na partição do Cognito sub e confere também o conversationId. O valor vem do registro da intenção; o modelo não envia usuário, valor nem limite como argumentos.

Uma operação TransactWriteItems na tabela de pagamentos:

1. reduz o limite somente se ainda for suficiente;
2. muda a intenção de pendente para paga somente se pertencer ao mesmo usuário e conversa e não estiver expirada;
3. reduz o estoque somente se houver unidades suficientes;
4. grava a transação somente se o identificador ainda não existir.

Se uma condição falhar, nenhuma dessas quatro mudanças é aplicada. A função relê os registros para devolver os códigos previstos (INTENCAO_JA_PAGA, INTENCAO_EXPIRADA, LIMITE_EXCEDIDO ou INTENCAO_INVALIDA). Conflitos transitórios que não correspondam a esses casos são propagados para tratamento pelo agente/API.

## Limite inicial

O perfil é criado sob demanda com DEFAULT_USER_LIMIT (padrão local: R$ 500,00). Se o administrador já tiver criado o perfil do sub na tabela, o valor existente prevalece. A etapa de infraestrutura documentará como provisionar limites diferentes por usuário antes do primeiro uso.

## Contexto confiável das tools

Os handlers das ferramentas recebem userId e conversationId em um objeto separado dos argumentos que o modelo pode preencher. Somente o agente pode invocar essas Lambdas e o agente injeta esses campos a partir do payload produzido pela Lambda da API, que extrai o sub do authorizer Cognito. A role do AgentCore não lê nenhuma tabela diretamente.

