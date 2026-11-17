#!/usr/bin/env bash
# Cria um usuário no Cognito (somente por convite) e registra o saldo inicial
# em Usuarios (DynamoDB). O Cognito envia o e-mail de convite com a senha
# temporária; no primeiro acesso o usuário define uma nova senha.
#
# Uso:
#   eval "$(bash scripts/aws-creds.sh)"
#   bash scripts/invite-user.sh <email> [limite_em_reais]
#   npm run user:invite -- <email> [limite_em_reais]
#
# Exemplo:
#   npm run user:invite -- instrutor@example.com 500
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUTS="$BASE_DIR/infra/cdk-outputs.json"
REGION="${AWS_REGION:-us-east-1}"
LIMITE_PADRAO_REAIS="${LIMITE_INICIAL_REAIS:-500}"

if [[ $# -lt 1 || -z "${1:-}" ]]; then
  echo "Uso: bash scripts/invite-user.sh <email> [limite_em_reais]"
  exit 1
fi

EMAIL="$1"
LIMITE_REAIS="${2:-$LIMITE_PADRAO_REAIS}"

if [[ ! "$EMAIL" == *"@"* ]]; then
  echo "ERRO: informe um e-mail válido (o Cognito usa e-mail como username)."
  exit 1
fi

if [[ ! -f "$OUTPUTS" ]]; then
  echo "ERRO: $OUTPUTS não encontrado. Rode o deploy primeiro (npm run deploy:api-agent)."
  exit 1
fi

read_output() {
  node -e "const o=require('$OUTPUTS')['Desafio1Stack']; process.stdout.write(o['$1']||'')"
}

USER_POOL_ID=$(read_output CognitoUserPoolId)
USUARIOS_TABLE=$(read_output UsuariosTableName)
USUARIOS_TABLE="${USUARIOS_TABLE:-luiz-henrique-usuarios}"

if [[ -z "$USER_POOL_ID" ]]; then
  echo "ERRO: output CognitoUserPoolId ausente em cdk-outputs.json"
  exit 1
fi

LIMITE_CENTAVOS=$(node -e "const v=Number(process.argv[1]); if(!Number.isFinite(v)||v<0){process.exit(1)}; process.stdout.write(String(Math.round(v*100)))" "$LIMITE_REAIS") || {
  echo "ERRO: limite inválido: $LIMITE_REAIS"
  exit 1
}

echo "==> User Pool: $USER_POOL_ID"
echo "==> E-mail: $EMAIL (limite inicial: R$ $LIMITE_REAIS)"

# 1. Cria o usuário. Sem --message-action SUPPRESS: o Cognito envia o convite
#    com a senha temporária configurada no template do User Pool.
if ! CREATE_OUTPUT=$(aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL \
  --region "$REGION" \
  --output json 2>&1); then
  if echo "$CREATE_OUTPUT" | grep -q "UsernameExistsException"; then
    echo "    (usuário já existe no Cognito; convite não reenviado)"
  else
    echo "$CREATE_OUTPUT"
    exit 1
  fi
fi

# 2. Lê o sub (identidade estável usada como PK em Usuarios).
SUB=$(aws cognito-idp admin-get-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" \
  --region "$REGION" \
  --query 'UserAttributes[?Name==`sub`].Value | [0]' \
  --output text)

if [[ -z "$SUB" || "$SUB" == "None" ]]; then
  echo "ERRO: não foi possível obter o sub do usuário $EMAIL"
  exit 1
fi

# 3. Registra o usuário na tabela (não sobrescreve saldo de quem já existe).
EXISTING=$(aws dynamodb get-item \
  --table-name "$USUARIOS_TABLE" \
  --key "{\"usuario_id\":{\"S\":\"$SUB\"}}" \
  --region "$REGION" \
  --query 'Item.limite_centavos.N' \
  --output text 2>/dev/null || true)

NOW=$(node -e "process.stdout.write(new Date().toISOString())")

if [[ -n "$EXISTING" && "$EXISTING" != "None" ]]; then
  echo "==> Usuário já registrado em $USUARIOS_TABLE (saldo: R$ $(node -e "process.stdout.write((Number(process.argv[1])/100).toFixed(2))" "$EXISTING"))"
else
  aws dynamodb put-item \
    --table-name "$USUARIOS_TABLE" \
    --region "$REGION" \
    --item "{
      \"usuario_id\": {\"S\": \"$SUB\"},
      \"email\": {\"S\": \"$EMAIL\"},
      \"limite_centavos\": {\"N\": \"$LIMITE_CENTAVOS\"},
      \"gasto_total_centavos\": {\"N\": \"0\"},
      \"status\": {\"S\": \"ativo\"},
      \"origem\": {\"S\": \"convite\"},
      \"criado_em\": {\"S\": \"$NOW\"},
      \"atualizado_em\": {\"S\": \"$NOW\"},
      \"convite_enviado_em\": {\"S\": \"$NOW\"}
    }" \
    --condition-expression "attribute_not_exists(usuario_id)"
  echo "==> Registrado em $USUARIOS_TABLE com saldo de R$ $LIMITE_REAIS"
fi

echo "OK: convite enviado para $EMAIL"
echo "    usuario_id: $SUB"
echo "    login: http://localhost:3000 (senha temporária no e-mail)"
