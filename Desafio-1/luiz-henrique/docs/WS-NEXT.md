# WebSocket — onde continuar

**Status em 2026-11-17:** parcial. O REST está estável e é o caminho usado pelo frontend.
O WebSocket foi implantado, mas `$default` ainda não entrega a resposta do chat.

## O que foi implementado

- `WebSocketApi` (`wss://lyjqn8a7i9.execute-api.us-east-1.amazonaws.com/prod`), stage `prod`.
- Rotas `$connect`, `$disconnect`, `$default` → Lambda `luiz-henrique-ws` (`AWS_PROXY`).
- `$connect`:
  - recebe `?token=<IdToken Cognito>&conversa_id=<uuid>`;
  - valida o ID token com `aws-jwt-verify` (user pool + client ID);
  - grava `connection_id`, `usuario_id`, `conversa_id`, `expira_em` em
    `luiz-henrique-conexoes` (TTL 1h).
- `$disconnect`: remove a conexão.
- `$default`: deveria invocar a `luiz-henrique-chat` com um evento sintético
  (`requestContext.authorizer.claims.sub`) e postar `{type:"chat", ...}` de volta na conexão.
- Script de smoke: `npm run test:ws` (`scripts/ws-smoke.mjs`). Ele lê `WebSocketUrl` do
  `cdk-outputs.json`, faz login com `TEST_EMAIL/TEST_PASSWORD`, conecta e envia “catalogo”.

## Sintoma atual

Depois do `onopen`, o cliente envia a mensagem e recebe do API Gateway:

```json
{"message":"Internal server error","connectionId":"...","requestId":"..."}
```

Nenhum log de `handleDefault` aparece no log group `/aws/lambda/luiz-henrique-ws`; o
`$connect` funciona (conexão gravada) e o `$disconnect` também é invocado.

## Evidência coletada

- Rotas e integração corretas:
  - `$connect`, `$disconnect`, `$default` → `integrations/062iqap` (`AWS_PROXY`);
  - Lambda `luiz-henrique-ws`.
- Env da Lambda correta:
  - `CONEXOES_TABLE=luiz-henrique-conexoes`
  - `CHAT_FUNCTION_NAME=luiz-henrique-chat`
  - `COGNITO_USER_POOL_ID=us-east-1_MsflknLt3`
  - `COGNITO_CLIENT_ID=4to9urndpesesb9f5av03v1i62`
- Resource policy da Lambda:
  - CDK criou permissão só para `$connect`:
    `arn:aws:execute-api:...:lyjqn8a7i9/*$connect`
  - a permissão extra que adicionamos gerou `.../lyjqn8a7i9/*/*/*`, que **não casa** com
    o ARN de WebSocket (`.../*$default`, sem barra antes de `$`).

## Próximo passo mais provável

Adicionar permissões explícitas para `$default` e `$disconnect` com o ARN no formato de
WebSocket. Em CDK:

```ts
const wsArn = (route: string) =>
  cdk.Stack.of(this).formatArn({
    service: 'execute-api',
    resource: webSocketApi.apiId,
    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    resourceName: `*${route}`, // *$default, *$disconnect
  });

this.webSocketFn.addPermission('WsDefaultPermission', {
  principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
  sourceArn: wsArn('$default'),
});
this.webSocketFn.addPermission('WsDisconnectPermission', {
  principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
  sourceArn: wsArn('$disconnect'),
});
```

Validar com:

```bash
aws lambda get-policy --function-name luiz-henrique-ws \
  --region us-east-1 --profile desafio-1 --query Policy --output text

npm run test:ws
```

Se o `$default` passar a ser invocado mas ainda falhar:

1. Confirmar o route selection expression (`$request.body.action`); enviar
   `{"action":"chat","messages":[...]}` explicitamente para forçar a rota.
2. Verificar se a Lambda do chat aceita o evento sintético sem headers
   (`requestContext.authorizer.claims.sub`); o handler já prioriza claims.
3. Verificar `PostToConnection`/`ManageConnections` e o endpoint
   `https://${domainName}/${stage}`.
4. Confirmar que a conexão não expirou/TTL nem foi fechada antes da resposta.

## Decisão atual

- Manter REST como caminho principal da demo/apresentação.
- Não bloquear a entrega por WebSocket; o requisito “Stream ou WebSocket” fica pendente.
- Os recursos WebSocket continuam implantados para o próximo ciclo. Custo incremental
  baixo (API Gateway WebSocket + tabela on-demand), sem uso em produção.
- O frontend ainda não tem cliente WebSocket; se o backend for corrigido, adicionar um
  cliente com fallback para REST.
