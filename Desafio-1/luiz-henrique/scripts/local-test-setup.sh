#!/usr/bin/env bash
# Local test setup for MiniStack (Desafio 1 - luiz-henrique)
# Cria Cognito User Pool + usuario de teste para testar a API por JWT.
# Como o MiniStack nao emite JWT via initiate-auth, usamos um JWT manual
# (assinatura nao e verificada pela API - so e lido o sub do payload).
#
# Tudo contra http://localhost:4566 (MiniStack).
#
# Usage:
#   ./scripts/local-test-setup.sh
#
# Requisitos:
#   - MiniStack rodando (docker compose up em dev-tools/)
#   - AWS CLI v2 com endpoint http://localhost:4566

set -euo pipefail

export AWS_PROFILE=local
export AWS_ENDPOINT_URL=http://localhost:4566
export AWS_DEFAULT_REGION=us-east-1
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test

PREFIX="luiz-henrique"
EMAIL="<test-email>"
PASSWORD="Temp1234!"

echo "==> Criando Cognito User Pool (se nao existir)..."
POOL_ID=$(aws cognito-idp list-user-pools --max-results 10 --endpoint-url http://localhost:4566 2>/dev/null \
  | python3 -c "import sys,json; pools=json.load(sys.stdin).get('UserPools',[]); print(pools[0]['Id'] if pools else '')" 2>/dev/null || true)

if [ -z "$POOL_ID" ]; then
  POOL_ID=$(aws cognito-idp create-user-pool \
    --pool-name "${PREFIX}-users" \
    --query 'UserPool.Id' --output text \
    --endpoint-url http://localhost:4566)
fi
echo "   UserPoolId: $POOL_ID"

echo "==> Criando User Pool Client (se nao existir)..."
CLIENT_ID=$(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL_ID" --max-results 10 --endpoint-url http://localhost:4566 2>/dev/null \
  | python3 -c "import sys,json; clients=json.load(sys.stdin).get('UserPoolClients',[]); print(clients[0]['ClientId'] if clients else '')" 2>/dev/null || true)

if [ -z "$CLIENT_ID" ]; then
  CLIENT_ID=$(aws cognito-idp create-user-pool-client \
    --user-pool-id "$POOL_ID" \
    --client-name "${PREFIX}-client" \
    --no-generate-secret \
    --query 'UserPoolClient.ClientId' --output text \
    --endpoint-url http://localhost:4566)
fi
echo "   ClientId: $CLIENT_ID"

echo "==> Criando usuario de teste (se nao existir)..."
aws cognito-idp admin-create-user \
  --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" \
  --temporary-password "$PASSWORD" \
  --message-action SUPPRESS \
  --endpoint-url http://localhost:4566 > /dev/null 2>&1 || true

aws cognito-idp admin-set-user-password \
  --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --password "$PASSWORD" \
  --permanent \
  --endpoint-url http://localhost:4566 > /dev/null 2>&1 || true
echo "   Usuario: $EMAIL / senha: $PASSWORD"

echo ""
echo "============================================="
echo "  Recursos prontos!"
echo "============================================="
echo "  UserPoolId : $POOL_ID"
echo "  ClientId   : $CLIENT_ID"
echo "  Email      : $EMAIL"
echo "  Senha      : $PASSWORD"
echo ""

# Gerar JWT manual (header.payload.assinatura_vazia)
echo "==> Gerando JWT manual para teste da API..."
HEADER=$(printf '{"alg":"none","typ":"JWT"}' | base64 -w0 | tr -d '=' | tr '/+' '_-')
PAYLOAD=$(printf '{"sub":"%s","email":"%s"}' "$EMAIL" "$EMAIL" | base64 -w0 | tr -d '=' | tr '/+' '_-')
TOKEN="${HEADER}.${PAYLOAD}."
echo "   Token: $TOKEN"
echo ""
echo "  Use este TOKEN no cabeçalho Authorization: Bearer <TOKEN>"
echo ""

echo "==> Testando o chat Lambda com o JWT..."
EVENT=$(printf '{"headers":{"Authorization":"Bearer %s"},"body":"{\"messages\":[{\"role\":\"user\",\"content\":[{\"text\":\"listar produtos\"}]}]}"}' "$TOKEN")

aws lambda invoke \
  --function-name luiz-henrique-chat \
  --payload "$EVENT" \
  --endpoint-url http://localhost:4566 \
  /tmp/api_resp.json 2>&1 && cat /tmp/api_resp.json
echo ""
echo ""
echo "  Resposta bruta:"
cat /tmp/api_resp.json
