# Intenção inválida — execução real da Lambda

Coleta: 16/11/2026. Função: paulo-antonio-pagamentos-tools. Região: us-east-1.

Invocação administrativa via AWS SSO, com contexto de autorizador sintético e usuário fictício. Não comprova autenticação positiva do Cognito/API Gateway. A intenção e o usuário não existem; nenhuma compra, usuário ou saldo foi criado ou alterado.

Entrada: POST /compras, intencao_id=int_evidencia_inexistente, metodo_pagamento=pix.

## Resposta

HTTP do handler: 200

```json
{
  "status": "recusado",
  "erro": "INTENCAO_INVALIDA",
  "mensagem": "Intenção indisponível para o usuário autenticado."
}
```

## Registros retornados pela própria invocação

```text
START RequestId: 517f2164-1ad7-4f90-a98d-a1107d6a5bbc Version: $LATEST
END RequestId: 517f2164-1ad7-4f90-a98d-a1107d6a5bbc
REPORT RequestId: 517f2164-1ad7-4f90-a98d-a1107d6a5bbc	Duration: 27.39 ms	Billed Duration: 28 ms	Memory Size: 256 MB	Max Memory Used: 89 MB
```

Os registros START/END/REPORT identificam esta execução da Lambda. A associação com realizar_compra decorre da entrada POST /compras e da resposta acima; os logs não registram uma chamada de ferramenta pelo modelo. Evidência de correlação AgentCore → ferramenta permanece pendente.
