# Frontend

A aplicação é exportada como arquivos estáticos. A configuração de runtime é carregada de /config.json, que deve ser gerado e enviado ao bucket pelo CDK no deploy. O arquivo deve conter apiUrl, userPoolId e userPoolClientId.

O login usa o Authenticator do Cognito com hideSignUp. A configuração do User Pool deve aceitar e-mail como identificador e convites com senha temporária; o Cognito força a troca da senha no primeiro login.

A API usa eventos SSE. O navegador envia o ID token Cognito por Authorization e consome o ReadableStream via fetch. O frontend envia somente a mensagem e o conversationId; o histórico é recuperado no backend.

