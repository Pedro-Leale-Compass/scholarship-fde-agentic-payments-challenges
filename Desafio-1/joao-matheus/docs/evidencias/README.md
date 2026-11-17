# Evidências de Validação e Testes Ponta a Ponta

Este documento reúne os registros e saídas de execução dos testes de segurança, conformidade e funcionalidades do Desafio 1.

---

## 1. Segurança e Controle de Acesso na Borda

### 1.1 Tentativa de Auto-Cadastro no Cognito (SignUp Bloqueado)
**Comando executado**:
```bash
aws cognito-idp sign-up \
  --client-id lbqun35uoa19c915apruf7cgr \
  --username atacante@exemplo.com \
  --password "Senha@123456"
```
**Resultado**:
```text
An error occurred (NotAuthorizedException) when calling the SignUp operation: SignUp is not permitted for this user pool
```
*Critério atendido: Auto-cadastro desabilitado no User Pool (`allowAdminCreateUserOnly: true`). Usuários entram unicamente por convite do administrador.*

---

### 1.2 Requisição sem Token JWT (`POST /chat`)
**Comando executado**:
```bash
curl.exe -i -X POST "https://gmtmb97y6l.execute-api.us-east-1.amazonaws.com/prod/chat" \
  -H "Content-Type: application/json" \
  -d '{"mensagem":"oi"}'
```
**Saída**:
```http
HTTP/1.1 401 Unauthorized
Date: Mon, 16 Nov 2026 18:38:13 GMT
Content-Type: application/json
Content-Length: 26
Connection: keep-alive
x-amzn-RequestId: 9694d105-3e3d-4fcd-b125-cfce34bf2d65
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Authorization,Content-Type
x-amzn-ErrorType: UnauthorizedException
x-amz-apigw-id: G8kPfG98oAMEPIA=
Access-Control-Allow-Methods: GET,POST,OPTIONS

{"message":"Unauthorized"}
```
*Critério atendido: Rejeição imediata pelo Cognito Authorizer na borda do API Gateway. A Lambda do chat não foi executada (sem logs no CloudWatch).*

---

### 1.3 Requisição com Token JWT Forjado/Inválido
**Comando executado**:
```bash
curl.exe -i -X POST "https://gmtmb97y6l.execute-api.us-east-1.amazonaws.com/prod/chat" \
  -H "Authorization: Bearer token.falso.invalido" \
  -H "Content-Type: application/json" \
  -d '{"mensagem":"oi"}'
```
**Saída**:
```http
HTTP/1.1 401 Unauthorized
Date: Mon, 16 Nov 2026 18:38:40 GMT
Content-Type: application/json
Content-Length: 26
Connection: keep-alive
x-amzn-RequestId: e05f7e40-2e64-4cec-9e03-acacd5283c4d
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Authorization,Content-Type
x-amzn-ErrorType: UnauthorizedException
x-amz-apigw-id: G8kTrGWAIAMEJgw=
Access-Control-Allow-Methods: GET,POST,OPTIONS

{"message":"Unauthorized"}
```
*Critério atendido: Validação de assinatura com a JWKS do User Pool falha e bloqueia com 401.*

---

### 1.4 Preflight CORS (OPTIONS) com Origem Não Autorizada
**Comando executado**:
```bash
curl.exe -i -X OPTIONS "https://gmtmb97y6l.execute-api.us-east-1.amazonaws.com/prod/chat" \
  -H "Origin: https://malicioso.example" \
  -H "Access-Control-Request-Method: POST"
```
**Saída**:
```http
HTTP/1.1 204 No Content
Date: Mon, 16 Nov 2026 18:38:50 GMT
Access-Control-Allow-Origin: http://localhost:5173
Access-Control-Allow-Headers: Authorization,Content-Type
Vary: Origin
Access-Control-Allow-Methods: GET,POST,OPTIONS
Access-Control-Max-Age: 3600
```
*Critério atendido: A origem `https://malicioso.example` não recebe cabeçalho correspondente. O navegador bloqueia qualquer requisição disparada por domínios não autorizados.*

---

## 2. Fluxo Completo de Negócio e Streaming SSE

Usuário de teste autenticado: `teste@exemplo.com` (`sub: 6498b4d8-20a1-700d-6e72-eaa63fccbe9a`).

### 2.1 Consulta de Catálogo (Turno 1)
- **Mensagem enviada**: `"Olá! Quais produtos vocês têm disponíveis?"`
- **Ferramenta acionada pelo agente**: `listar_catalogo`
- **Fluxo SSE recebido**:
```text
data: {"tipo":"delta","texto":"Olá! Bem-vindo à nossa loja virtual! 😊\n\nVou listar todos os produtos disponíveis no nosso catálogo para você:"}
data: {"tipo":"ferramenta","nome":"listar_catalogo"}
data: {"tipo":"delta","texto":"Ótimo! Aqui estão os produtos que temos disponíveis:\n\n**1. Fone Bluetooth** (ID: prod_001)\n   - **Preço:** R$ 249,90\n   - **Descrição:** Fone de ouvido sem fio bluetooth com cancelamento de ruído\n\n**2. Carregador Turbo** (ID: prod_002)\n   - **Preço:** R$ 80,00\n   - **Descrição:** Carregador de tomada turbo 30W USB-C\n\n**3. Cabo USB** (ID: prod_003)\n   - **Preço:** R$ 30,00\n   - **Descrição:** Cabo USB para USB-C reforçado 1m\n\nTem interesse em algum desses produtos? É só me informar qual você gostaria de comprar e a quantidade! 🛒"}
data: {"tipo":"fim"}
```

---

### 2.2 Registro de Intenção de Compra (Turno 2)
- **Mensagem enviada**: `"Quero 1 fone bluetooth"`
- **Ferramenta acionada pelo agente**: `registrar_intencao` com `produto_id: "prod_001"` e `quantidade: 1`
- **Fluxo SSE recebido**:
```text
data: {"tipo":"delta","texto":"Perfeito! Vou registrar sua intenção de compra de 1 Fone Bluetooth."}
data: {"tipo":"ferramenta","nome":"registrar_intencao"}
data: {"tipo":"delta","texto":"Excelente! Sua intenção de compra foi registrada com sucesso! 🎉\n\n**📋 Resumo da Compra:**\n- **Produto:** Fone Bluetooth\n- **Quantidade:** 1\n- **Valor Total:** R$ 249,90\n- **ID da Intenção:** int_1363f913d299410f981f03a6597e5d5c\n- **Válido por:** 10 minutos\n\nAgora, como você gostaria de pagar?\n- **Cartão de crédito** (digite: cartao)\n- **Pix** (digite: pix)\n\nQual é sua preferência? 💳 ou 📱"}
data: {"tipo":"fim"}
```

---

### 2.3 Pagamento com Pix e Transação ACID (Turno 3)
- **Mensagem enviada**: `"Pode pagar com pix"`
- **Ferramenta acionada pelo agente**: `realizar_compra` com `intencao_id: "int_1363f913d299410f981f03a6597e5d5c"` e `metodo_pagamento: "pix"`
- **Fluxo SSE recebido**:
```text
data: {"tipo":"delta","texto":"Perfeito! Vou processar o pagamento via Pix agora."}
data: {"tipo":"ferramenta","nome":"realizar_compra"}
data: {"tipo":"delta","texto":"🎉 **Compra Aprovada!**\n\nSua transação foi processada com sucesso! Aqui estão os detalhes:\n\n- **ID da Transação:** tx_int_1363f913d299410f981f03a6597e5d5c\n- **Valor Pago:** R$ 249,90\n- **Método:** Pix\n- **Limite Restante:** R$ 250,10\n- **Data:** 16/11/2026 às 18:46\n\nSeu Fone Bluetooth está a caminho! 📦 Você receberá em breve um e-mail com os detalhes da entrega.\n\nObrigado por comprar conosco! Se precisar de algo mais, é só chamar! 😊"}
data: {"tipo":"fim"}
```

---

### 2.4 Restauração do Histórico via `GET /conversas`
**Chamada**: `GET /conversas` com `Authorization: Bearer <idToken>`
**Resposta retornada**:
```json
{
  "mensagens": [
    {
      "role": "user",
      "texto": "Olá! Quais produtos vocês têm disponíveis?",
      "criado_em": "2026-11-16T18:45:04.172Z"
    },
    {
      "role": "assistant",
      "texto": "Olá! Bem-vindo à nossa loja virtual! 😊\n\nVou listar todos os produtos disponíveis no nosso catálogo para você:Ótimo! Aqui estão os produtos que temos disponíveis:\n\n**1. Fone Bluetooth** (ID: prod_001)...",
      "criado_em": "2026-11-16T18:45:09.075Z"
    },
    {
      "role": "user",
      "texto": "Quero 1 fone bluetooth",
      "criado_em": "2026-11-16T18:45:25.867Z"
    },
    {
      "role": "assistant",
      "texto": "Perfeito! Vou registrar sua intenção de compra de 1 Fone Bluetooth.Excelente! Sua intenção de compra foi registrada com sucesso!...",
      "criado_em": "2026-11-16T18:45:30.439Z"
    },
    {
      "role": "user",
      "texto": "Pode pagar com pix",
      "criado_em": "2026-11-16T18:46:17.414Z"
    },
    {
      "role": "assistant",
      "texto": "Perfeito! Vou processar o pagamento via Pix agora.🎉 **Compra Aprovada!**...",
      "criado_em": "2026-11-16T18:46:21.920Z"
    }
  ]
}
```

---

## 3. Testes de Casos de Borda e Idempotência no DynamoDB

### 3.1 Tentativa de Replay de Intenção Já Paga
- Ao tentar executar `realizar_compra` com uma intenção já aprovada (`int_1363f913d299410f981f03a6597e5d5c`):
- A escrita transacional (`TransactWriteItems`) falha na condição `attribute_not_exists(transacao_id)` e `status = :pendente`.
- Retorno da ferramenta:
  ```json
  {
    "status": "recusado",
    "codigo": "INTENCAO_JA_PAGA",
    "mensagem": "Esta intenção de compra já foi paga anteriormente."
  }
  ```

### 3.2 Tentativa de Compra com Limite Insuficiente
- Ao tentar comprar itens cujo valor total excede o `limite_restante`:
- A condição `limite_restante >= :valor` falha na transação atômica.
- Retorno da ferramenta:
  ```json
  {
    "status": "recusado",
    "codigo": "LIMITE_EXCEDIDO",
    "mensagem": "Limite insuficiente para realizar esta compra."
  }
  ```

### 3.3 Tentativa de Forjar Identidade (`usuario_id`)
- Se o usuário tentar enviar `"usuario_id": "outro_usuario"` no corpo JSON de `POST /chat`, o campo é ignorado pelo handler.
- O `usuario_id` é injetado diretamente pelo autorizador Cognito (`claims.sub`) através de uma closure léxica Python no agente, impedindo que o modelo ou o usuário manipulem o comprador.
