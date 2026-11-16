# Frontend

Chat em React 19, Vite e TypeScript. O login é feito pelo **Amazon Cognito**, com o `Authenticator` do Amplify UI. A resposta do assistente aparece em **streaming**, e o histórico vem do servidor.

Em produção, o site é servido pelo CloudFront (S3 privado + OAC, F9), e a API responde em `/api/*` **na mesma origem**, sem CORS.

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Servidor de desenvolvimento do Vite |
| `npm test` | vitest: leitura do stream NDJSON, cliente da API, estado da conversa e `config.json`. Não acessa a AWS. |
| `npm run build` | Type-check e build de produção em `dist/` |
| `npm run lint` | oxlint |

## Configuração em tempo de execução

O app lê `/config.json` ao abrir. Em produção, o `deploy.sh` gera esse arquivo a partir dos Outputs da stack (F9). Assim, o mesmo build serve para qualquer ambiente, e nenhum id fica fixo no código:

```json
{ "userPoolId": "us-east-1_XXXXXXXXX", "userPoolClientId": "xxxxxxxxxxxxxxxxxxxxxxxxxx" }
```

Nada aqui é segredo: o app client é público e não tem secret. Se o arquivo faltar ou vier inválido, o app mostra uma tela de erro em vez de quebrar.

## Desenvolvimento local, contra a stack já publicada

**Atalho:** depois de um `SEM_FRONTEND=1 ./infra/deploy.sh`, os dois arquivos abaixo já foram gerados pelo script. É só rodar `npm install` e `npm run dev`.

Para preparar à mão:

1. Copie `config.example.json` para `public/config.json` (ignorado pelo git) e preencha com os Outputs `UserPoolId` e `UserPoolClientId`.
2. Crie `frontend/.env.local` (também ignorado) com `API_URL=<Output ApiUrl>`, por exemplo `https://abc123.execute-api.us-east-1.amazonaws.com/prod`. O Vite repassa `/api/*` para a API, como o CloudFront faz em produção.
3. Rode `npm run dev` e entre com um usuário convidado (`infra/scripts/criar-usuario.sh`).

## Como funciona

- **Login** ([`App.tsx`](src/App.tsx)): o `<Authenticator hideSignUp>` não oferece cadastro, porque o user pool só aceita usuários convidados. Ele cuida do login por e-mail, da troca obrigatória da senha temporária do convite e do "esqueci minha senha", com textos em português.
- **Token** ([`lib/sessao.ts`](src/lib/sessao.ts)): cada chamada usa o **ID token** da sessão, que o Amplify renova sozinho com o refresh token. O ID token é o que o autorizador do API Gateway aceita e o único que traz o e-mail. Um `401` encerra a sessão.
- **Chat** ([`lib/api.ts`](src/lib/api.ts)):
  - `POST /api/chat` envia só `{ mensagem }`. O histórico fica no servidor, e o frontend não consegue alterá-lo.
  - A resposta é lida com `fetch` e `ReadableStream`, linha a linha (NDJSON, em [`lib/ndjson.ts`](src/lib/ndjson.ts)).
  - Cada evento atualiza a tela pelas funções puras de [`lib/conversa.ts`](src/lib/conversa.ts):

    | Evento | Na tela |
    |---|---|
    | `texto` | Vai para o balão do assistente |
    | `ferramenta` | Mostra "consultando o catálogo…" |
    | `fim` | Atualiza o limite no cabeçalho |
    | `erro` | Vira um balão de aviso |

  - Uma conexão que cai antes do `fim` também vira aviso.
- **Histórico:** ao abrir, `GET /api/conversas` traz as mensagens anteriores, então recarregar a página mantém a conversa.
- **Perfil:** `GET /api/perfil` mostra o e-mail e o limite disponível.

Ao criar uma tool nova, acrescente o rótulo dela em `ROTULOS_FERRAMENTA` ([`lib/conversa.ts`](src/lib/conversa.ts)).
