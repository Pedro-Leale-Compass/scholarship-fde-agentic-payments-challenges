# API de perfil e chat

Esta pasta é a entrada do backend para o frontend. Suas funções rodam em **AWS Lambda**, atrás do API Gateway. O usuário entra pelo Cognito e envia seu token nas requisições protegidas.

## O que cada parte faz

| Pasta | Responsabilidade |
|---|---|
| `sessao/` | Atende `GET /sessao` e informa a identidade autenticada. |
| `perfil/` | Atende `GET /me`, cria o perfil no primeiro acesso e consulta o saldo disponível. |
| `chat/` | Cria e consulta conversas, chama o agente e entrega a resposta progressivamente. |

O chat oferece `POST /chat`, `GET /conversas`, `POST /conversas` e `GET /conversas/{conversa_id}`. O histórico fica no DynamoDB e só pode ser consultado pelo dono da conversa.

A identidade vem do token validado pelo API Gateway. O frontend não pode substituir o usuário enviando outro identificador no corpo da mensagem. Repetições de uma requisição já concluída reutilizam seu resultado, sem executar novamente o agente.

## Como validar

A partir desta pasta, com Node.js 24 e dependências instaladas:

```bash
npm --prefix chat test
npm --prefix chat run build
```

Os testes do perfil ficam na suíte de `infra/tests/`. A criação das APIs e suas permissões está definida em `infra/`.

Veja o [guia geral](../README.md) para os comandos completos de deploy.
