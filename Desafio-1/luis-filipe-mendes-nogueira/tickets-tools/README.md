# Ferramentas MCP — legado da Fase 1

Esta pasta guarda as ferramentas de compra da versão local anterior, escritas em TypeScript e acessadas pelo protocolo MCP. O agente antigo de `gemini-chat/` iniciava esse servidor para consultar eventos e processar compras simuladas.

**Na Fase 2, as ferramentas equivalentes estão em `tools/` e rodam em AWS Lambda com DynamoDB. Este módulo legado não é necessário para o frontend atual.**

## Ferramentas disponíveis nesta versão

| Ferramenta | O que faz |
|---|---|
| `listar_catalogo` | Consulta eventos, preços e vagas. |
| `registrar_intencao` | Reserva ingressos por cinco minutos e calcula o total no backend. |
| `realizar_compra` | Valida a intenção e solicita o débito de saldo ao serviço local de autenticação. |

Os dados desta versão ficam em SQLite. O código está em `src/`, incluindo as regras de reserva, pagamento e devolução de vagas de intenções vencidas. Os testes ficam em `tests/`.

## Como validar

A partir desta pasta e com as dependências instaladas:

```bash
npm test
npm run build
```

O servidor usa entrada e saída padrão para conversar com o agente; ele não é uma API HTTP para o navegador. Consulte a [documentação da Fase 1](../docs/fase1/README.md) para a arquitetura anterior e o [guia principal](../README.md) para a aplicação atual.
