# Autenticação local — legado da Fase 1

Esta pasta guarda o serviço de autenticação usado na versão local anterior. Ele foi mantido como referência da evolução do projeto.

**Na Fase 2, o login é feito pelo Cognito e o perfil é consultado pela API AWS. O frontend atual não depende deste serviço.**

## O que este serviço fazia

- Cadastrava usuários e validava login.
- Emitia tokens JWT para as chamadas locais.
- Consultava o perfil e controlava o saldo de compras simuladas.
- Guardava os dados em SQLite.

O código está em `src/` e os testes em `tests/`. O arquivo `.env.example` mostra a configuração necessária para a versão legada; credenciais não devem ser incluídas no repositório.

## Execução e testes

No Compose, este serviço pertence ao perfil `legado` e fica desativado na execução padrão. O uso desse perfil está descrito no [guia geral](../README.md).

Para executar seus testes, a partir desta pasta e com as dependências instaladas:

```bash
npm test
```

Para usar a aplicação atual, inicie apenas o frontend pelo Compose, conforme o README principal. Não é necessário iniciar `auth/`.
