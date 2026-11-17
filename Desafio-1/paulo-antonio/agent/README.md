# Agente de compras na AWS

Implementação em TypeScript com AWS SDK, sem dependência de Strands (opcional no desafio).
Runtime HTTP no Amazon Bedrock AgentCore, empacotado como ZIP Node.js 22 ARM64.
O deploy direto de código é suportado pelo AgentCore; não exige Docker/ECR.

## Fluxo

1. Frontend local envia o ID token Cognito para `POST /chat`.
2. API Gateway REST valida o token antes de executar a Lambda.
3. A Lambda obtém `sub` das claims, lê o histórico dessa pessoa no DynamoDB e chama AgentCore por IAM.
4. AgentCore chama Claude Haiku 4.5 com **todo** o histórico da conversa, incluindo ferramentas e retornos.
5. Ferramentas são invocadas em Lambda separada. A identidade vem do contexto confiável, nunca dos argumentos do modelo.
6. Resposta NDJSON passa por Lambda response streaming e API Gateway até o navegador.

`realizar_compra` chamado pelo modelo prepara uma confirmação visual. A compra só
é executada quando o navegador envia a confirmação do botão e ela coincide com a
intenção/método guardados no servidor. O valor mostrado vem da intenção, não do modelo.
Uma confirmação não autoriza outras compras. A ferramenta mantém a transação atômica
e bloqueia repetição, limite excedido, titular diferente e expiração.

## Histórico e falhas

Tabela `*-pagamentos-conversas`: chave composta `userId` + `conversationId`, mensagens
Bedrock completas, título, atualização, confirmação pendente, versão e lease de execução.
`GET /conversas` lista conversas; `?conversationId=UUID` recupera uma conversa do titular.
O histórico não é guardado em localStorage. Tokens de login ficam apenas no sessionStorage.

Cada rodada de ferramentas salva um checkpoint. A gravação usa condição de dono/versão;
uma conversa admite uma execução por vez. Lease de 180 segundos, Lambda de 120 segundos,
chamada AgentCore limitada a 110 segundos. Pagamentos e chamadas ao runtime não têm retry
automático. O usuário deve consultar o estado se perder a resposta.

Limites: mensagem de até 4.000 caracteres, seis rodadas, quatro ferramentas por rodada,
1.200 tokens de saída por chamada ao modelo. Uma conversa acima de 120 blocos ou 240 KB
exige iniciar outra; mensagens antigas **não são truncadas**. A lista mostra até 100 conversas.

## Permissões

- Lambda chat: leitura/gravação somente de conversas e invocação do runtime específico.
- Lambda histórico: somente leitura/consulta de conversas.
- Runtime: perfil Haiku selecionado e seus modelos nas três regiões dos EUA, Lambda de
  ferramentas, leitura do ZIP específico e logs próprios. Sem acesso ao DynamoDB.
- Lambda ferramentas: somente as três tabelas de pagamentos. Sem acesso ao modelo.
- Não há URL pública de Lambda nem autenticação anônima no runtime.

## Verificação

Dentro de `agent/`: `pnpm run typecheck`, `pnpm test`, `pnpm run build`.
Integração opcional após deploy: `node test/aws.integration.ts --account CONTA_ESPERADA`.
O teste usa SSO `desafio-1`, fixtures isoladas e limpeza por chaves conhecidas. Invoca a
Lambda administrativamente com claims sintéticas; não substitui teste positivo de Cognito.
Com o bloqueio de cadastro da Anthropic, `--expect-unavailable` verifica somente o tratamento
da indisponibilidade, histórico e isolamento. Não confundir esse resultado com sucesso do agente.

Documentação AWS:
- [Deploy direto Node.js](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-code-deploy-node.html)
- [Streaming Lambda no API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-streaming-lambda-configure.html)
