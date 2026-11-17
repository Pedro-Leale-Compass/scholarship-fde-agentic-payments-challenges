# Apresentação — 5 minutos

**Formato:** 4 min de apresentação + 1 min de perguntas.  
**Objetivo:** mostrar problema → solução → resultado → aprendizado, com foco no valor do
agente e na migração para AWS.

## 1. Problema (30s)

“A loja precisa vender sem atendente, mas com regras de negócio seguras: catálogo,
intenção de compra, pagamento simulado por cartão/Pix, limite por usuário e uma intenção
que não pode ser paga duas vezes.”

O desafio é fazer um **agente conversacional** executar essas ações sem inventar preço, ID
ou status de pagamento.

## 2. Solução (1min)

Arquitetura implementada:

- Frontend Next.js com Cognito/Authenticator, rodando localmente (`npm run dev`).
- API Gateway REST com autorizador JWT; `POST /chat` e `GET /conversas`.
- Lambda do chat: identidade vem do `sub` do token; estado de checkout por conversa.
- Agente Strands no Bedrock AgentCore Runtime com Claude Haiku 4.5.
- Três tools em Lambda: `listar_catalogo`, `registrar_intencao`, `realizar_compra`.
- DynamoDB: usuários/saldo, conversas/histórico, intenções, catálogo e conexões WebSocket.
- Preço autoritativo no catálogo (`preco_centavos`); o modelo envia só `produto_id` e
  quantidade.

**O que adaptamos da arquitetura de referência:**

- O frontend não está em S3 + CloudFront + OAC; por restrição da conta, roda local. O
  instrutor consegue rodar com `npm run setup && npm run dev`.
- O WebSocket foi iniciado, mas está **parcial**: `$connect` autentica e grava a conexão;
  `$default` ainda retorna `Internal server error` no API Gateway. O chat principal usa
  REST, que está estável. O próximo passo está documentado em `docs/WS-NEXT.md`.
- O restante segue a referência: API Gateway, Cognito, Lambdas, AgentCore, Bedrock,
  DynamoDB e CDK.

## 3. Resultado (2min)

Demo principal (cartão e Pix) com o usuário de teste. Capturas em ordem:

1. **Login Cognito** — `01-login.png`
2. **Chat vazio** — `02-chat-inicial.png`
3. **Catálogo** — `03-catalogo.png`
4. **Intenção registrada** — `04-intencao-fone.png`
5. **Compra aprovada no Pix** — `05-pagamento-pix.png`
6. **Intenção do monitor** — `06-intencao-monitor.png`
7. **Limite excedido no cartão** — `06-limite-cartao.png`
8. **Compra aprovada no cartão** — `07-pagamento-cartao.png`

Frase de efeito para a demo:

> “O modelo conversa, mas quem manda no dinheiro é o backend: o preço vem do catálogo, o
> `usuario_id` vem do token e o pagamento usa transação condicional. Se o modelo inventar
> um ID, a resposta é uma falha visível, não uma cobrança.”

Mostre também:

- o ID da intenção retornado;
- a mudança de status para `paga` no DynamoDB (opcional);
- o log `guard: payment_fallback_verified` ou `registration_fallback` quando o modelo omite
  uma tool.

## 4. Aprendizado (30s)

**Principal desafio:** o modelo não é uma fonte confiável de estado. O bug inicial era o
runtime “consertar” IDs antigos em vez de falhar; a correção foi remover overrides/grounding,
persistir o estado por conversa e deixar o backend validar tudo.

**Próximo passo:** fechar o WebSocket (`$default`), rodar a suíte de 100+ casos e, se a SCP
permitir, publicar o frontend em S3 + CloudFront.

## 5. Perguntas (1min)

Respostas curtas sugeridas:

- **Por que REST se o PDF pede Stream/WebSocket?** O WebSocket está iniciado; o `$connect`
  funciona, mas o `$default` ainda falha no API Gateway. Mantivemos REST para a demo não
  quebrar. O plano de continuidade está em `docs/WS-NEXT.md`.
- **O modelo pode alterar preço?** Não. `registrar_intencao` recebe só `produto_id` e
  quantidade e resolve `preco_centavos` no catálogo.
- **Como evita pagamento duplo?** `TransactWriteItems` com condição `status = pendente` e
  saldo suficiente.
- **O que acontece se o modelo inventar um ID?** A tool retorna `INTENCAO_INVALIDA`; a
  resposta mostra a falha, sem cobrança.
- **O instrutor consegue rodar?** Sim: `npm run setup`, `npm run dev`, login com o convite
  do Cognito. O `config.json` versionado aponta para a API atual.

## Plano B

Se a demo ao vivo falhar, use as capturas desta pasta na ordem acima. O vídeo/prints são
aceitos pelo PDF. Não mostre `.env`, tokens, senhas ou dados de outros usuários.

## Antes de apresentar

```bash
# 1. Garanta a API/agente no ar
npm run check:model

# 2. Resete o saldo do usuário de demo
npm run user:reset-limit -- luiz@desafio.test

# 3. Suba o frontend
npm run dev
```

Use um usuário de teste (não o e-mail do instrutor) e não exiba credenciais. O convite do
instrutor é enviado pelo Cognito com `npm run user:invite -- <email> 500`.
