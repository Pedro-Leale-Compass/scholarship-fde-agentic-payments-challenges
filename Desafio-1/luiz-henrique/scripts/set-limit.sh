#!/usr/bin/env bash
# Define ou reseta o saldo de gasto (limite_centavos) de um usuário.
#
# Uso:
#   bash scripts/set-limit.sh set   <email|usuario_id> <limite_em_reais>
#   bash scripts/set-limit.sh reset <email|usuario_id>
#
# Atalhos:
#   npm run user:set-limit   -- <email|usuario_id> <limite_em_reais>
#   npm run user:reset-limit -- <email|usuario_id>
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUTS="$BASE_DIR/infra/cdk-outputs.json"
REGION="${AWS_REGION:-us-east-1}"
LIMITE_PADRAO_REAIS="${LIMITE_INICIAL_REAIS:-500}"

usage() {
  echo "Uso:"
  echo "  bash scripts/set-limit.sh set   <email|usuario_id> <limite_em_reais>"
  echo "  bash scripts/set-limit.sh reset <email|usuario_id>"
}

if [[ $# -lt 2 ]]; then
  usage
  exit 1
fi

MODE="$1"
IDENT="$2"

case "$MODE" in
  set)
    if [[ $# -lt 3 ]]; then
      usage
      exit 1
    fi
    LIMITE_REAIS="$3"
    ;;
  reset)
    LIMITE_REAIS="$LIMITE_PADRAO_REAIS"
    ;;
  *)
    usage
    exit 1
    ;;
esac

if [[ ! -f "$OUTPUTS" ]]; then
  echo "ERRO: $OUTPUTS não encontrado. Rode o deploy primeiro."
  exit 1
fi

read_output() {
  node -e "const o=require('$OUTPUTS')['Desafio1Stack']; process.stdout.write(o['$1']||'')"
}

USER_POOL_ID=$(read_output CognitoUserPoolId)
USUARIOS_TABLE=$(read_output UsuariosTableName)
USUARIOS_TABLE="${USUARIOS_TABLE:-luiz-henrique-usuarios}"

LIMITE_CENTAVOS=$(node -e "const v=Number(process.argv[1]); if(!Number.isFinite(v)||v<0){process.exit(1)}; process.stdout.write(String(Math.round(v*100)))" "$LIMITE_REAIS") || {
  echo "ERRO: limite inválido: $LIMITE_REAIS"
  exit 1
}

EMAIL_ATTR=""
if [[ "$IDENT" == *"@"* ]]; then
  if [[ -z "$USER_POOL_ID" ]]; then
    echo "ERRO: output CognitoUserPoolId ausente em cdk-outputs.json"
    exit 1
  fi
  SUB=$(aws cognito-idp admin-get-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "$IDENT" \
    --region "$REGION" \
    --query 'UserAttributes[?Name==`sub`].Value | [0]' \
    --output text)
  if [[ -z "$SUB" || "$SUB" == "None" ]]; then
    echo "ERRO: usuário $IDENT não encontrado no Cognito"
    exit 1
  fi
  EMAIL_ATTR="$IDENT"
else
  SUB="$IDENT"
fi

ITEM_JSON=$(aws dynamodb get-item \
  --table-name "$USUARIOS_TABLE" \
  --key "{\"usuario_id\":{\"S\":\"$SUB\"}}" \
  --query 'Item' \
  --output json 2>/dev/null || true)

HAS_ITEM=$(node -e "try{const o=JSON.parse(process.argv[1]||'{}');process.stdout.write(o.usuario_id?'1':'0')}catch(e){process.stdout.write('0')}" "$ITEM_JSON")
SALDO_ANTERIOR=$(node -e "try{const o=JSON.parse(process.argv[1]||'{}');process.stdout.write(String(o.limite_centavos?.N ?? '0'))}catch(e){process.stdout.write('0')}" "$ITEM_JSON")
NOW=$(node -e "process.stdout.write(new Date().toISOString())")

if [[ "$HAS_ITEM" == "1" ]]; then
  aws dynamodb update-item \
    --table-name "$USUARIOS_TABLE" \
    --region "$REGION" \
    --key "{\"usuario_id\":{\"S\":\"$SUB\"}}" \
    --update-expression "SET limite_centavos = :valor, atualizado_em = :agora" \
    --expression-attribute-values "{
      \":valor\": {\"N\": \"$LIMITE_CENTAVOS\"},
      \":agora\": {\"S\": \"$NOW\"}
    }" \
    --condition-expression "attribute_exists(usuario_id)" \
    --output json > /dev/null
else
  if [[ -z "$EMAIL_ATTR" ]]; then
    echo "ERRO: usuário $SUB não tem registro em $USUARIOS_TABLE; informe o e-mail para criar."
    exit 1
  fi
  aws dynamodb put-item \
    --table-name "$USUARIOS_TABLE" \
    --region "$REGION" \
    --item "{
      \"usuario_id\": {\"S\": \"$SUB\"},
      \"email\": {\"S\": \"$EMAIL_ATTR\"},
      \"limite_centavos\": {\"N\": \"$LIMITE_CENTAVOS\"},
      \"gasto_total_centavos\": {\"N\": \"0\"},
      \"status\": {\"S\": \"ativo\"},
      \"origem\": {\"S\": \"manual\"},
      \"criado_em\": {\"S\": \"$NOW\"},
      \"atualizado_em\": {\"S\": \"$NOW\"}
    }" \
    --condition-expression "attribute_not_exists(usuario_id)" \
    --output json > /dev/null
fi

format_brl() {
  node -e "process.stdout.write('R$ '+(Number(process.argv[1])/100).toFixed(2))" "$1"
}

echo "OK: saldo de $IDENT atualizado"
echo "    usuario_id: $SUB"
echo "    antes:  $(format_brl "$SALDO_ANTERIOR")"
echo "    depois: $(format_brl "$LIMITE_CENTAVOS")"
