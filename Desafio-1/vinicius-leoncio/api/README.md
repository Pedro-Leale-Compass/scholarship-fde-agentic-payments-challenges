# API do chat

`handler.ts` expõe POST `/chat` e GET `/conversations/{conversationId}` para uma API Gateway REST com resposta em streaming.

A API Gateway chama primeiro um TOKEN authorizer Lambda, que valida o ID token Cognito. O handler lê o `sub` autenticado do contexto do authorizer; ignora qualquer `userId` enviado pelo navegador. O histórico completo é carregado e gravado em DynamoDB; o histórico de exibição é separado.

A API invoca o AgentCore Runtime (`AGENT_RUNTIME_ARN`) e envia eventos SSE `status`, `message`, `done` ou `error`. Atualmente, `status` chega no início, mas o agente devolve uma resposta completa antes do evento `message`; ainda não há envio incremental de tokens do modelo.

A stack CDK configura integração REST `STREAM`, CORS limitado ao domínio do CloudFront e o authorizer. A chamada do agente exige ID de conversa UUID, porque esse valor também identifica a sessão do Runtime.
