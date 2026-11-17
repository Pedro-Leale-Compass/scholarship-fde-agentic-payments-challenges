# Interface estática

## Prévia local sem AWS

Na pasta `frontend`, execute `pnpm run build` e depois `pnpm run preview:local`.
Abra http://127.0.0.1:4173. O servidor aceita conexões apenas deste computador.

A faixa amarela identifica o teste visual. Use dados fictícios para conferir campos, exibição da senha e disposição em telas pequenas. Os links da faixa permitem reiniciar a tela e testar a configuração ausente. Login e recuperação de senha não funcionam: a configuração é fictícia e a política de segurança da prévia bloqueia conexões externas. A prévia não valida Cognito, API Gateway, Bedrock ou compras. Encerre com Ctrl+C.

Esse servidor fica separado da aplicação e não é incluído na publicação. Não altera a configuração nem as permissões de produção.

## Aplicação

Após o deploy `--mode backend`, execute `node scripts/preview-local.mjs --aws` e abra exatamente http://127.0.0.1:4173. Esse modo utiliza o Cognito e a API reais dos outputs locais; a faixa superior identifica a conexão real. A prévia offline sem `--aws` continua disponível. Pare o servidor anterior antes de trocar o modo. Esta é a forma de entrega solicitada pelo Pedro em 16/11/2026: frontend somente local, backend e autenticação na AWS, sem deploy do frontend.

Para uma cópia nova do repositório com backend já existente, siga o
[passo a passo do README principal](../README.md#rodar-somente-o-frontend-com-o-backend-já-existente):
instalar dependências, gerar o build, recuperar a configuração pública e iniciar o
servidor. Não é necessário recriar a infraestrutura para executar o frontend.

Primeira etapa da migração. Usa Next.js com exportação estática e Amplify Authenticator conectado ao Cognito criado pelo CDK. Não usa Amplify Hosting e não possui rotas de servidor Next.js.

```powershell
pnpm install --frozen-lockfile --store-dir ../.pnpm-store
pnpm run build
```

O resultado fica em `out/`. O deploy cria e publica `/config.json` depois do build, com `apiUrl`, `region`, `userPoolId` e `userPoolClientId`. Não criar credenciais nem segredos nesse arquivo.

Sem configuração, a página apresenta um erro recuperável e não tenta autenticar. O modo local conectado lê `.deploy/config.json` sem copiá-lo para o código. CORS aceita exclusivamente `http://127.0.0.1:4173` no deploy backend; no deploy completo, aceita exclusivamente a origem CloudFront.

O usuário entra por convite, troca a senha temporária e confirma acesso à API. Depois pode conversar com Haiku, recuperar conversas e confirmar compras simuladas com Pix/cartão. O histórico completo fica no DynamoDB. O chat só paga após confirmação no botão, mesmo quando o usuário escreve “confirmo”. O formulário direto de compras continua disponível. Consulte `agent/README.md` e `docs/API-PAGAMENTOS.md` na raiz. A base da Fase 1 permanece nas pastas antigas.

Para testar o chat, peça “Quero ver os produtos e meu limite”. Depois peça um produto,
quantidade e método. Confira o resumo antes de clicar em “Confirmar compra simulada”.
Atualize a conversa ou recupere-a em “Conversas salvas” para conferir persistência.
Após falha de conexão, não repita o pagamento: peça ao assistente para consultar o
estado da intenção. Ele dispõe de uma ferramenta de consulta que não debita o limite.

As respostas do assistente exibem Markdown (negrito, listas e tabelas) com
`react-markdown` e `remark-gfm`, sem interpretar HTML enviado pelo modelo. Tabelas largas
rolam dentro da própria mensagem em telas pequenas. Durante o streaming, as respostas
separadas por consultas às ferramentas recebem uma quebra de parágrafo. O texto salvo
no histórico não é alterado por essa apresentação.
