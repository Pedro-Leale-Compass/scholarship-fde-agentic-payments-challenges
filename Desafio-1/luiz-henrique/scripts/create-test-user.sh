#!/usr/bin/env bash
# Cria o usuário de teste no Cognito User Pool (sem auto-cadastro).
# Lê TEST_EMAIL/TEST_PASSWORD do .env e o UserPoolId do cdk-outputs.json.
#
# Uso:
#   eval "$(bash scripts/aws-creds.sh)"
#   bash scripts/create-test-user.sh
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$BASE_DIR/.env"
OUTPUTS="$BASE_DIR/infra/cdk-outputs.json"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERRO: $ENV_FILE não encontrado. Copie de .env.example e preencha TEST_EMAIL/TEST_PASSWORD."
  exit 1
fi

if [[ ! -f "$OUTPUTS" ]]; then
  echo "ERRO: $OUTPUTS não encontrado. Rode o deploy do CDK primeiro (npm run deploy:api-agent)."
  exit 1
fi

# Carrega variáveis do .env (ignora comentários e linhas vazias)
set -a
. "$ENV_FILE"
set +a

if [[ -z "${TEST_EMAIL:-}" || -z "${TEST_PASSWORD:-}" ]]; then
  echo "ERRO: TEST_EMAIL e TEST_PASSWORD devem estar definidos no .env"
  exit 1
fi

REGION="${AWS_REGION:-us-east-1}"

read_output() {
  node -e "const o=require('$OUTPUTS')['Desafio1Stack']; process.stdout.write(o['$1']||'')"
}

USER_POOL_ID=$(read_output CognitoUserPoolId)

if [[ -z "$USER_POOL_ID" ]]; then
  echo "ERRO: output CognitoUserPoolId ausente em cdk-outputs.json"
  exit 1
fi

echo "==> Criando usuário no Cognito User Pool: $USER_POOL_ID"
echo "    email: $TEST_EMAIL"

aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$TEST_EMAIL" \
  --user-attributes Name=email,Value="$TEST_EMAIL" Name=email_verified,Value=true \
  --message-action SUPPRESS \
  --region "$REGION" \
  --output text > /dev/null 2>&1 || {
  # Usuário pode já existir — ignora UsernameExistsException
  echo "    (usuário já existe ou erro esperado na criação, seguindo)"
}

echo "==> Definindo senha permanente"
aws cognito-idp admin-set-user-password \
  --user-pool-id "$USER_POOL_ID" \
  --username "$TEST_EMAIL" \
  --password "$TEST_PASSWORD" \
  --permanent \
  --region "$REGION" \
  --output text

echo "OK: usuário $TEST_EMAIL criado/atualizado no User Pool $USER_POOL_ID"
