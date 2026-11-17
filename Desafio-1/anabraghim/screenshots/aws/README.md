# Evidências na AWS

Capturas do deploy real, exibidas na seção [Evidências](../../README.md#evidências) do README principal. Dados pessoais (e-mail, conta) aparecem tarjados.

| Arquivo | O que mostra |
|---|---|
| `0-orcamento-criado.png` | Alerta de custo criado no AWS Budgets antes do primeiro deploy. |
| `1-pagina-login.png` | Tela de login do Cognito (Amplify), sem a opção de criar conta: só usuários convidados entram. |
| `2-chamada-api-sem-token-rejeitada.png` | `POST /api/chat` sem o header `Authorization`, respondido com **`401`** e `{"erro":"Sessão expirada ou inválida. Entre novamente."}` pelo próprio API Gateway. |
| `3-compra-aprovada-com-cartao.png` | Compra aprovada com **cartão**: `transacao_id`, valor e limite restante, com o limite do cabeçalho já reduzido. |
| `4-compra-aprovada-pix.png` | O mesmo fluxo, pagando com **Pix**. |
| `5-tentativa-bloqueada-limite-excedido.png` | Pagamento recusado porque o valor passa do limite disponível (`LIMITE_EXCEDIDO`). |
| `6-intencao-invalida.png` | Pedido para pagar um `intencao_id` inventado: o agente explica que a intenção não existe (`INTENCAO_INVALIDA`). |

**Para novas capturas:** use PNG, mantenha estes nomes e confira antes de salvar que não aparece token completo, senha, e-mail de terceiros, id da conta AWS ou chave de acesso.
