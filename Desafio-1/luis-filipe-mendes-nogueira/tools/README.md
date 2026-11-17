# Ferramentas de compra na AWS

Esta pasta implementa as regras de negócio usadas pelo agente da Fase 2. O código Python de `pagamentos/` é publicado em três funções **AWS Lambda**, que consultam e alteram dados no DynamoDB.

## O que cada ferramenta faz

| Ferramenta | Responsabilidade |
|---|---|
| `listar_catalogo` | Lista eventos, preços e vagas, com filtro opcional por categoria. |
| `registrar_intencao` | Reserva ingressos por cinco minutos e calcula o total com o preço do catálogo. |
| `realizar_compra` | Confirma o pagamento simulado por cartão ou Pix, valida o saldo e grava a transação. |

O código compartilhado trata erros e libera as vagas das intenções vencidas. Os valores financeiros são guardados em centavos para evitar erros de arredondamento.

## Regras importantes

A identidade do usuário chega separada dos argumentos escolhidos pelo modelo. As ferramentas conferem a posse da intenção, prazo, disponibilidade e saldo. As alterações de pagamento são agrupadas no banco para impedir débito duplicado ou saldo inconsistente em chamadas concorrentes.

O agente não define preços nem recebe acesso direto às tabelas. O navegador acessa as APIs protegidas, em vez de chamar essas ferramentas diretamente.

## Como validar

Os testes ficam em `infra/tests/`. A partir da pasta principal do projeto, com o ambiente Python da infraestrutura preparado:

```bash
infra/.venv/bin/python -m unittest discover -s infra/tests -p 'test_*.py' -v
```

O CDK empacota o código desta pasta no deploy. Veja o [README principal](../README.md) para publicar e testar o fluxo completo.
