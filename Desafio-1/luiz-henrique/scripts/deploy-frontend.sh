#!/usr/bin/env bash
# Build e deploy do frontend estático no AWS Amplify Hosting.
# Requer: infra/cdk-outputs.json gerado por `cdk deploy --outputs-file`.
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
APP_ID=$(read_output AmplifyAppId)
POOL_ID=$(read_output CognitoUserPoolId)
CLIENT_ID=$(read_output CognitoUserPoolClientId)

if [[ -z "$API_URL" || -z "$APP_ID" ]]; then
  echo "ERRO: outputs ApiUrl/AmplifyAppId ausentes em cdk-outputs.json"
  exit 1
fi

echo "==> Build do frontend"
cd "$BASE_DIR/frontend"
npm run build

echo "==> config.json de runtime"
cat > out/config.json <<EOF
{
  "apiUrl": "${API_URL%/}",
  "userPoolId": "$POOL_ID",
  "userPoolClientId": "$CLIENT_ID",
  "region": "us-east-1"
}
EOF

# também deixa o config disponível para `npm run dev:frontend`
mkdir -p public
cp out/config.json public/config.json

ZIP_FILE="${TMPDIR:-/tmp}/desafio1-frontend.zip"
echo "==> Empacotando $ZIP_FILE"
rm -f "$ZIP_FILE"
(cd out && zip -q -r "$ZIP_FILE" .)

echo "==> Criando deployment no Amplify (app $APP_ID)"
DEPLOYMENT=$(aws amplify create-deployment --app-id "$APP_ID" --branch-name main --region us-east-1)
JOB_ID=$(echo "$DEPLOYMENT" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).jobId')
UPLOAD_URL=$(echo "$DEPLOYMENT" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).zipUploadUrl')

echo "==> Upload"
curl -s -X PUT -T "$ZIP_FILE" -H 'Content-Type: application/zip' "$UPLOAD_URL" -o /dev/null -w "   HTTP %{http_code}\n"

echo "==> Iniciando deployment (job $JOB_ID)"
aws amplify start-deployment --app-id "$APP_ID" --branch-name main --job-id "$JOB_ID" --region us-east-1 > /dev/null

echo "==> Aguardando publicação..."
for _ in $(seq 1 60); do
  STATUS=$(aws amplify get-job --app-id "$APP_ID" --branch-name main --job-id "$JOB_ID" --region us-east-1 --query 'job.summary.status' --output text)
  echo "   status: $STATUS"
  case "$STATUS" in
    SUCCEED) break ;;
    FAILED|CANCELLED) echo "ERRO: deploy falhou"; exit 1 ;;
  esac
  sleep 5
done

echo "OK: frontend publicado em https://main.${APP_ID}.amplifyapp.com"
