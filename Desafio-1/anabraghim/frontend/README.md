# Frontend

Chat em React 19, Vite e TypeScript. O login é feito pelo **Amazon Cognito**, com o `Authenticator` do Amplify UI. A resposta do assistente aparece em **streaming**, e o histórico vem do servidor.

O mesmo código roda de dois jeitos:

| Modo | Quem serve o site | Quem repassa `/api/*` ao API Gateway |
|---|---|---|
| Local | Vite (`npm run dev`, `localhost:5173`) | Proxy do Vite ([`vite.config.ts`](vite.config.ts)), com o alvo em `API_URL` |
| Hospedado | CloudFront + S3 privado | CloudFront |

Nos dois modos, a página e a API ficam **na mesma origem**, então o código chama só caminhos relativos (`/api/...`) e não há CORS. Como fazer o deploy em cada modo está no [README principal](../README.md#-deploy).

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Servidor de desenvolvimento do Vite |
| `npm test` | vitest: leitura do stream NDJSON, cliente da API, estado da conversa e `config.json`. Não acessa a AWS. |
| `npm run build` | Type-check e build de produção em `dist/` |
| `npm run lint` | oxlint |

## Configuração em tempo de execução

O app lê `/config.json` ao abrir ([`lib/config.ts`](src/lib/config.ts)). O `deploy.sh` gera esse arquivo a partir dos Outputs da stack: em `public/config.json` no modo local e direto no site no modo hospedado. Assim, o mesmo build serve para qualquer ambiente, e nenhum id fica fixo no código:

```json
{ "userPoolId": "us-east-1_XXXXXXXXX", "userPoolClientId": "xxxxxxxxxxxxxxxxxxxxxxxxxx" }
```

Nada aqui é segredo: o app client é público e não tem secret. Se o arquivo faltar ou vier inválido, o app mostra uma tela de erro em vez de quebrar.

## Rodar localmente, contra uma stack publicada

| Arquivo (ignorado pelo git) | Conteúdo | Vem do Output |
|---|---|---|
| `public/config.json` | `{ "userPoolId": "...", "userPoolClientId": "..." }` (modelo em [`config.example.json`](config.example.json)) | `UserPoolId`, `UserPoolClientId` |
| `.env.local` | `API_URL=https://<id>.execute-api.us-east-1.amazonaws.com/prod` | `ApiUrl` |

1. **Com acesso à AWS:** o `SEM_FRONTEND=1 ./infra/deploy.sh` já gera os dois arquivos. **Sem acesso:** receba-os de quem fez o deploy (nenhum dos dois tem segredo).
2. `npm install` e `npm run dev`, depois abra `http://localhost:5173`.
3. Entre com um usuário convidado (`infra/scripts/criar-usuario.sh`).

O repasse de `/api/*` é do servidor do Vite, por isso use o `npm run dev`. Servir o `dist/` direto não alcança a API. O Vite só lê o `.env.local` ao iniciar: se criar ou alterar esse arquivo, reinicie o `npm run dev`.

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
