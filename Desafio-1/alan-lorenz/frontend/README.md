# Frontend local do chatbot

O frontend Next.js é executado localmente em `http://localhost:3000`. Ele usa
o Amazon Cognito e a API de chat provisionados pela stack AWS; não publica nem
hospeda arquivos do frontend na AWS. A autenticação usa AWS Amplify no
navegador, e o ID token Cognito é enviado como
`Authorization: Bearer <JWT>` para o endpoint protegido.

## Pré-requisitos

- Node.js 22.x e npm.
- A stack backend implantada em `us-east-1`, com acesso ao User Pool e à API.
- AWS CLI configurada para consultar os outputs da stack, ou os valores
  `UserPoolId`, `UserPoolClientId` e `ChatApiEndpoint` fornecidos pelo operador.
- Um usuário criado por administrador no Cognito. O auto cadastro está
  desativado; no primeiro login, use a senha temporária do convite e defina
  uma nova senha.

## Configuração inicial

Abra esta pasta (`Desafio-1/alan-lorenz/frontend`) no PowerShell e instale as
dependências:

```powershell
npm ci
Copy-Item .env.example .env.local
```

Para consultar os outputs da stack:

```powershell
aws cloudformation describe-stacks `
  --stack-name AlanLorenzInfraStack `
  --region us-east-1 `
  --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" `
  --output table
```

Edite `.env.local` e preencha os valores correspondentes:

| Variável | Output CDK |
|---|---|
| `NEXT_PUBLIC_USER_POOL_ID` | `UserPoolId` |
| `NEXT_PUBLIC_USER_POOL_CLIENT_ID` | `UserPoolClientId` |
| `NEXT_PUBLIC_CHAT_API_URL` | `ChatApiEndpoint` |

Esses IDs e a URL identificam recursos públicos; não coloque senhas, tokens ou
chaves AWS nessas variáveis. `.env.local` é ignorado pelo Git. Reinicie o
servidor de desenvolvimento depois de alterar o arquivo.

## Executar

```powershell
npm run check
npm run dev
```

Abra `http://localhost:3000` no navegador e entre com a conta Cognito
convidada. Use exatamente `localhost` (não `127.0.0.1`): a API permite CORS
somente para essa origem local. A criação de contas não é feita pela interface.

O histórico é mantido na sessão atual do navegador e enviado completo a cada
turno. Embora as mensagens também sejam gravadas no DynamoDB, ainda não há uma
rota para listar conversas anteriores; recarregar a página não restaura a
conversa.

## Diagnóstico rápido

- **Configuração incompleta:** confirme que as três variáveis estão preenchidas
  em `.env.local` e reinicie `npm run dev`.
- **Erro `401`:** entre novamente com o usuário Cognito; tokens expirados ou
  inválidos são recusados pelo API Gateway.
- **Falha de rede/CORS:** confirme que abriu `http://localhost:3000` e que
  `NEXT_PUBLIC_CHAT_API_URL` é o output `ChatApiEndpoint` da stack na região
  `us-east-1`.
- **Sem acesso Cognito:** peça a um administrador para criar a conta e enviar
  um convite; auto cadastro está desativado.

Para implantar ou validar o backend e a autenticação na AWS, consulte o
[`README da infraestrutura`](../infra/README.md). O deploy da stack não
constrói nem publica este frontend.
