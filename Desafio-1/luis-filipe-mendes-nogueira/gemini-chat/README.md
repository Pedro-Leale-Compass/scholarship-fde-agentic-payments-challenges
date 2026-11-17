# Chat com Gemini — legado da Fase 1

Esta pasta contém a versão anterior do chat, feita em Next.js e integrada ao Google Gemini. Ela foi preservada como referência da Fase 1.

**O chat atual está em `frontend/`, e o agente atual está em `agent/`, publicado no AgentCore. Esta pasta não participa da execução padrão da Fase 2.**

## O que esta versão fazia

- Exibia as telas de login, conversa e pedido.
- Recebia mensagens por uma rota de chat no próprio Next.js.
- Usava Gemini para interpretar as solicitações.
- Chamava as ferramentas de `tickets-tools/` pelo protocolo MCP.
- Consultava o serviço local `auth/` para autenticação e saldo.

O código está em `src/`, os testes em `tests/` e o exemplo de configuração em `.env.local.example`. A chave do Gemini pertence ao backend e não deve ser publicada nem enviada ao navegador.

## Execução e testes

No Compose, esta aplicação é o serviço `app`, habilitado apenas pelo perfil `legado`. Ela usa os serviços e configurações da arquitetura anterior.

Para executar os testes, a partir desta pasta e com as dependências instaladas:

```bash
npm test
```

Para abrir a interface atual, siga o [README principal](../README.md) e inicie o serviço `frontend`.
