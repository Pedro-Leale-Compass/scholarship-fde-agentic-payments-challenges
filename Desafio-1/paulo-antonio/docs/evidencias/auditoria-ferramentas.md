# Registros das chamadas de ferramentas

Publicado e validado na AWS em 17/11/2026. A stack
`paulo-antonio-pagamentos` terminou em `UPDATE_COMPLETE`. Frontend permanece local.

O runtime envolve cada chamada à Lambda com dois registros JSON:
`tool_call_started` e `tool_call_finished`. `invocationId` agrupa chamadas de uma
requisição do agente; `callId` relaciona o início ao término de cada chamada.
`operation` identifica a operação efetivamente encaminhada à Lambda, por uma lista
fechada de rotas. O término informa duração e `success`, `refused` ou `error`.

Esses identificadores são gerados no servidor e não são IDs de usuário, conversa
ou transação. Argumentos, respostas, mensagens do modelo, senhas, tokens e textos
de exceção não são incluídos por esse registrador. Os registros já existentes de
erro no runtime não foram alterados.

A solicitação de confirmação visual pelo modelo pode consultar uma intenção sem
efetuar pagamento: nesse caso a operação registrada é `consultar_intencao`.
`realizar_compra` só aparece quando o runtime encaminha POST /compras.

Validação local: 10 testes do agente, TypeScript e build passaram. O novo teste
confirma correlação entre início/fim, separação entre chamadas, preservação do
resultado/erro original e ausência de conteúdo privado no registro.

## Evidência real

[Eventos coletados do CloudWatch](tool-audit-cloudwatch.json), grupo
`/aws/bedrock-agentcore/runtimes/paulo_antonio_pagamentos-w3KSvw5kUO-DEFAULT`.
Cada registro preserva timestamp UTC, stream, eventId e os campos JSON emitidos
pelo runtime. Foram coletados seis pares completos de início/término.

| Operação | Resultado | Duração |
|---|---|---|
| listar_catalogo | refused | 598 ms |
| consultar_limite | success | 532 ms |
| listar_catalogo | success | 49 ms |
| registrar_intencao | success | 222 ms |
| consultar_intencao | success | 36 ms |
| realizar_compra | success | 159 ms |

A primeira consulta de catálogo foi recusada; uma consulta posterior teve sucesso.
O registrador não guarda argumentos nem a razão detalhada da recusa. Não inferir
essa razão apenas desses eventos. `success` significa retorno sem campo `erro`,
não uma autorização para novos pagamentos.

A integração administrativa `agent/test/aws.integration.ts --account CONTA` passou:
Lambda → AgentCore → Haiku → ferramentas, confirmação, compra única, histórico
completo e isolamento. Usou usuário e dados fictícios isolados, removidos ao final;
não debitou o saldo do usuário Cognito. Esse script não testa autenticação positiva
do Cognito. A proteção das oito rotas foi revalidada pelo smoke: 401 com token ausente
ou inválido, preflight e CORS restritos à interface local.

Esta evidência é textual, coletada pela API de logs; não é captura visual do console.
