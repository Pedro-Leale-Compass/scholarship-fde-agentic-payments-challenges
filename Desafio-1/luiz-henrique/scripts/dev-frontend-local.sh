#!/usr/bin/env bash
# Executa o frontend local em http://localhost:3000, apontando para a API na AWS.
# Requer: infra/cdk-outputs.json gerado por `cdk deploy`.
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUTS="$BASE_DIR/infra/cdk-outputs.json"

if [[ ! -f "$OUTPUTS" ]]; then
  echo "ERRO: $OUTPUTS não encontrado. Rode o deploy do CDK primeiro."
  exit 1
fi

read_output() {
  node -e "const o=require('$OUTPUTS')['Desafio1Stack']; process.stdout.write(o['$1']||'')"
}

API_URL=$(read_output ApiUrl)
POOL_ID=$(read_output CognitoUserPoolId)
CLIENT_ID=$(read_output CognitoUserPoolClientId)

if [[ -z "$API_URL" || -z "$POOL_ID" || -z "$CLIENT_ID" ]]; then
  echo "ERRO: outputs ausentes em cdk-outputs.json"
  exit 1
fi

echo "==> Gerando frontend/public/config.json"
cat > "$BASE_DIR/frontend/public/config.json" <<EOF
{
  "apiUrl": "${API_URL%/}",
  "userPoolId": "$POOL_ID",
  "userPoolClientId": "$CLIENT_ID",
  "region": "us-east-1"
}
EOF

echo "==> Iniciando frontend em http://localhost:3000"
cd "$BASE_DIR/frontend"
npm run dev
