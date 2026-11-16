# Testes — Desafio 1 (luiz-henrique)

Esta pasta contém a suíte de testes Postman para validar a API de chat de pagamentos.

## Arquivos

| Arquivo | Descrição |
|---------|-----------|
| `postman-collection.json` | Coleção com login no Cognito e testes do endpoint `/chat` |
| `postman-environment.json` (opcional) | Variáveis de ambiente para importar no Postman |

## Fluxo de testes

1. **Login (Cognito InitiateAuth)** — faz `USER_PASSWORD_AUTH` usando `testEmail`/`testPassword` e extrai o `IdToken` da resposta, salvando-o na variável de coleção `idToken`.
2. **POST /chat com token** — envia mensagem com `Authorization: Bearer {{idToken}}` e valida resposta 200 com campo `reply`/`message`.
3. **POST /chat sem token** — envia mensagem sem cabeçalho `Authorization` e valida resposta `401`.

## Como usar

1. Importe os dois arquivos no Postman (Import → File):
   - `postman-collection.json` — a coleção de requisições
   - `postman-environment.json` — o "ambiente" (equivalente a `.env` do Postman), com as variáveis `testEmail`, `testPassword`, `userPoolClientId`, `apiUrl`, `region` e `idToken`
2. Selecione o ambiente "Desafio 1 - Ambiente (luiz-henrique)" no canto superior direito do Postman.
3. Preencha as variáveis (equivalente a editar o `.env`):
   - `testEmail` — do `.env` (`TEST_EMAIL`)
   - `testPassword` — do `.env` (`TEST_PASSWORD`)
   - `userPoolClientId` — do output `CognitoUserPoolClientId` em `infra/cdk-outputs.json`
   - `apiUrl` — do output `ApiUrl` em `infra/cdk-outputs.json`
   - `region` — `us-east-1`
4. Execute a coleção na ordem: primeiro o login, depois as requisições de chat.
5. O `idToken` é preenchido automaticamente pelo script de teste do login e reaproveitado nas requisições seguintes.

> `postman-environment.json` contém credenciais e está no `.gitignore` (não commitar). Cada desenvolvedor preenche localmente.

## Pré-requisitos

- Stack implantada (`npm run deploy:api-agent`) para gerar `infra/cdk-outputs.json` com `ApiUrl` e `CognitoUserPoolClientId`.
- Usuário de teste criado no Cognito (via `TEST_EMAIL`/`TEST_PASSWORD` no `.env` ou manualmente no console).

## Atualizando as variáveis de ambiente

Quando a stack for reimplantada ou os valores do `.env` mudarem, atualize o `postman-environment.json`:

1. Confirme o novo `CognitoUserPoolClientId` e `ApiUrl` em `infra/cdk-outputs.json`.
2. Confirme `TEST_EMAIL` e `TEST_PASSWORD` em `.env`.
3. Abra `tests/postman-environment.json` e substitua os valores de:
   - `userPoolClientId` — pelo `CognitoUserPoolClientId` do `cdk-outputs.json`.
   - `apiUrl` — pelo `ApiUrl` do `cdk-outputs.json`.
   - `testEmail` — pelo `TEST_EMAIL` do `.env`.
   - `testPassword` — pelo `TEST_PASSWORD` do `.env`.
4. Salve o arquivo e reimporte no Postman (Import → File) ou edite as variáveis diretamente no ambiente selecionado.
5. Reexecute o login para gerar um novo `idToken`.
