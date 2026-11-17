# Registro dos testes manuais informados pelo usuário

Fonte: mensagens e transcrições fornecidas pelo usuário nesta conversa em 16/11/2026.
Este arquivo é um registro textual; não é uma captura do navegador nem uma auditoria
independente do DynamoDB. Não contém senhas, tokens ou códigos de recuperação.

| Etapa | Resultado informado |
|---|---|
| Catálogo e limite pelo chat | Seis produtos; limite R$ 5.000, gasto R$ 1.899,90, disponível R$ 3.100,10 |
| Cadeira, 1 unidade, Pix | Confirmação no botão, compra aprovada por R$ 1.299; disponível R$ 1.801,10 |
| Nova consulta de limite | Disponível R$ 1.801,10; gasto R$ 3.198,90 |
| PS5 por Pix no chat | Assistente informou preço R$ 4.799 e saldo insuficiente, sem prosseguir |
| PS5 pelo formulário | Após orientação para confirmar, usuário respondeu “deu certo” ao teste de recusa |
| Intenção expirada | Após orientação para aguardar mais de 3 minutos e confirmar, usuário respondeu “funciono” |
| Cadeira, 1 unidade, cartão | Confirmação no botão, compra aprovada por R$ 1.299; disponível R$ 502,10 |
| Apresentação do chat | Após correção de Markdown/espaçamento, usuário respondeu “esta tudo certo” |

Transações citadas pelo usuário:

- Pix: `tx_int_88f6dbd6-c3da-422c-a3d1-53fe090e528f`.
- Cartão: `tx_int_61bb39c7-5e72-43de-b271-8b9590f035bd`.

Conferência aritmética: gasto inicial R$ 1.899,90 + R$ 1.299 + R$ 1.299 = R$ 4.497,90;
R$ 5.000 − R$ 4.497,90 = R$ 502,10. Pagamentos são simulados.

A resposta de saldo está correta, mas não demonstra sozinha que o usuário recarregou a
página antes de consultar. A recuperação manual do histórico após recarregar continua
pendente de confirmação explícita. As recusas por limite/expiração foram confirmadas
verbalmente, sem JSON ou screenshot específico fornecido nesta etapa.
