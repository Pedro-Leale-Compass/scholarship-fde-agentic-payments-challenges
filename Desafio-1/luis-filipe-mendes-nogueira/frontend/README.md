# Interface do usuário

Esta pasta contém a interface atual do agente de compras, feita em **Next.js e React**. Ela oferece login, conversas, consulta ao catálogo, acompanhamento do pedido e saldo disponível.

O frontend roda **localmente em http://localhost:3001**, servido por Nginx no Docker Compose. Autenticação e backend ficam na AWS; não é necessário iniciar os serviços legados.

## Partes principais

| Local | Função |
|---|---|
| `src/app/` | Páginas de login, chat e perfil. |
| `src/components/` | Elementos visuais, como conversa, mensagens e painel de pedido. |
| `src/services/` | Login Cognito e comunicação com as APIs. |
| `src/utils/` | Adaptação do histórico, leitura do pedido e recuperação de mensagens pendentes. |
| `public/config.json` | URLs das APIs e identificadores públicos do Cognito. |
| `tests/` | Testes do streaming, histórico e recuperação de requisições. |

As respostas chegam progressivamente pelo chat. O histórico tem rolagem própria e, em telas pequenas, os painéis são acessados pelas opções Conversas, Chat e Pedido.

## Como iniciar

Na pasta principal do projeto, um nível acima desta:

```bash
docker compose up -d --build frontend
```

Depois, abra **http://localhost:3001** com sua conta convidada. Alterações no código ou na configuração exigem reconstruir a imagem com o mesmo comando.

Para testar a partir desta pasta, com Node.js 24 e dependências instaladas:

```bash
npm test
npm run build
```

O build gera `out/`, que é servido pelo Nginx. A publicação em S3/CloudFront está suspensa por orientação do instrutor. Veja o [guia geral](../README.md) para configuração e diagnóstico.
