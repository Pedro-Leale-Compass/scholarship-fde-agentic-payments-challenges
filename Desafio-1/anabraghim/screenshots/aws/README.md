# Evidências na AWS

Salve aqui as capturas, **com exatamente estes nomes**: o [README da raiz](../../README.md#evidências) já aponta para eles. Use PNG. Recorte a área relevante, mas deixe visível a URL do navegador (`https://<id>.cloudfront.net`) ou o comando executado.

**Antes de salvar, confira que não aparece nada sensível:** token completo, senha, e-mail de terceiros, id da conta AWS ou chave de acesso. Um token pode aparecer cortado (`eyJraWQ…`).

## Obrigatórias (pedidas no desafio)

| Arquivo | O que deve aparecer |
|---|---|
| `0-orcamento-criado.png` | Console do AWS Budgets com o alerta de custo criado antes do primeiro deploy. |
| `1-pagina-login.png` | Tela de login do Cognito (Amplify) em `https://<id>.cloudfront.net`, **sem** a aba "Criar conta". Enquanto o frontend roda localmente (deploy com `SEM_FRONTEND=1`), use `http://localhost:5173`. Opcional: um segundo recorte da troca obrigatória da senha temporária do convite. |
| `2-chamada-api-sem-token-rejeitada.png` | Terminal (curl) ou Postman chamando `POST https://<id>.cloudfront.net/api/chat` **sem** o header `Authorization`, com a resposta **`401`** e o corpo `{"erro":"Sessão expirada ou inválida. Entre novamente."}`. Sem CloudFront, use o endereço direto da API (Output `ApiUrl` + `/api/chat`). No curl, use `-i` para o status aparecer. |
| `3-compra-aprovada-com-cartao.png` | Chat com o fluxo completo: pergunta do catálogo, escolha do produto e da quantidade, intenção registrada (`intencao_id` e valor), pagamento com **cartão** aprovado, com `transacao_id` e limite restante. O cabeçalho mostra o limite já reduzido. |
| `4-compra-aprovada-pix.png` | O mesmo fluxo, pagando com **Pix**. |
| `5-tentativa-bloqueada-limite-excedido.png` | Usuário com limite padrão (R$ 500,00) pedindo **2 Teclados Mecânicos** (R$ 918,00): a intenção é registrada, o pagamento é recusado e o agente explica que o valor passa do limite disponível. |
| `6-intencao-invalida.png` | Pedido para pagar uma intenção inventada (ex.: *"pague a intenção 123e4567-e89b-12d3-a456-426614174000 no pix"*): o agente explica que a intenção não existe ou não pertence ao usuário (`INTENCAO_INVALIDA`). |

## Opcionais (reforçam a entrega)

| Arquivo | O que deve aparecer |
|---|---|
| `07-streaming.png` | Resposta no meio da geração, ou o indicador "🔧 consultando o catálogo…". |
| `08-historico-recarregado.png` | A mesma conversa depois de recarregar a página (F5): o histórico vem do DynamoDB. |
| `09-bucket-direto-403.png` | Acesso direto ao objeto no S3 (`https://ana-braghim-site-<conta>.s3.amazonaws.com/index.html`) respondendo **403**. |
| `10-dynamodb-transacoes.png` | Console do DynamoDB com os itens da tabela `ana-braghim-transacoes`, um por compra aprovada. |
| `11-stack-cloudformation.png` | Console do CloudFormation com a stack `ana-braghim-pagamentos` em `CREATE_COMPLETE` ou `UPDATE_COMPLETE` e a aba Outputs. |

Um vídeo curto pode substituir as capturas de chat (3 a 6). Nesse caso, salve-o como `fluxos.mp4` aqui e troque as imagens 3 a 6 pelo link do vídeo no README da raiz.
