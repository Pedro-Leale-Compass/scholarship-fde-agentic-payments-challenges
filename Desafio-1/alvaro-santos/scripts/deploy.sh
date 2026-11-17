#!/usr/bin/env bash
# =============================================================================
# Pipeline de Deploy em Comando Único e Teardown — Desafio 1 (AWS Cloud)
#
# Executa o ciclo da infraestrutura CDK em us-east-1 (conta 006739439488):
#   - Modo padrão (diretriz oficial do desafio): implanta backend e autenticação
#     na AWS (DynamoDB, Cognito, 3 Tool Lambdas, AgentCore Runtime, API Gateway),
#     libera CORS para http://localhost:5173 e gera frontend/.env.local com os
#     outputs reais para execução local do frontend React.
#   - Modo --with-cloudfront: ativa -c skipFrontendHost=false para provisionar
#     também S3 privado + CloudFront OAC + BucketDeployment (uso opcional futuro).
#   - Modo --destroy: executa cdk destroy --all e exibe o checklist de teardown.
#
# Uso:
#   bash scripts/deploy.sh [--with-cloudfront] [--destroy] [--profile <perfil>]
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_DIR="${PROJECT_ROOT}/infra"
FRONTEND_DIR="${PROJECT_ROOT}/frontend"
OUTPUTS_FILE="${INFRA_DIR}/cdk-outputs.json"
FRONTEND_ENV_FILE="${FRONTEND_DIR}/.env.local"

AWS_PROFILE="${AWS_PROFILE:-alvaro-fellowship}"
WITH_CLOUDFRONT=false
DESTROY_MODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-frontend)
      WITH_CLOUDFRONT=false
      shift
      ;;
    --with-cloudfront)
      WITH_CLOUDFRONT=true
      shift
      ;;
    --destroy)
      DESTROY_MODE=true
      shift
      ;;
    --profile)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Erro: --profile exige o nome do perfil AWS CLI." >&2
        exit 1
      fi
      AWS_PROFILE="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,18p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "Argumento desconhecido: $1" >&2
      exit 1
      ;;
  esac
done

export AWS_DEFAULT_REGION="us-east-1"

CDK_CONTEXT_ARGS=()
if [[ "${WITH_CLOUDFRONT}" == "true" ]]; then
  CDK_CONTEXT_ARGS+=(-c "skipFrontendHost=false")
fi

write_frontend_env_from_outputs() {
  node -e '
    const fs = require("fs");
    const outputsPath = process.argv[1];
    const targetEnvPath = process.argv[2];
    const raw = JSON.parse(fs.readFileSync(outputsPath, "utf8"));
    const stack = raw["alvaro-agentic-payments-stack"] || Object.values(raw)[0] || {};
    const findByPrefix = (prefix) => {
      const entry = Object.entries(stack).find(([k]) => k.startsWith(prefix));
      return entry ? String(entry[1]).trim() : "";
    };
    const apiUrl = findByPrefix("ChatApiChatApiUrlOutput").replace(/\/+$/, "");
    const poolId = findByPrefix("AuthUserPoolIdOutput");
    const clientId = findByPrefix("AuthUserPoolClientIdOutput");
    if (!apiUrl || !poolId || !clientId) {
      console.error("Outputs esperados ausentes em cdk-outputs.json:", Object.keys(stack));
      process.exit(1);
    }
    const content = [
      `VITE_API_URL=${apiUrl}`,
      `VITE_COGNITO_USER_POOL_ID=${poolId}`,
      `VITE_COGNITO_CLIENT_ID=${clientId}`,
      "VITE_COGNITO_REGION=us-east-1",
      "VITE_USE_MOCKS=false",
      "",
    ].join("\n");
    fs.writeFileSync(targetEnvPath, content, "utf8");
  ' "${OUTPUTS_FILE}" "${FRONTEND_ENV_FILE}"
}

echo "== Perfil AWS CLI: ${AWS_PROFILE} | Região: ${AWS_DEFAULT_REGION}"

if [[ "${DESTROY_MODE}" == "true" ]]; then
  echo "== Iniciando teardown completo via AWS CDK (cdk destroy)..."
  cd "${INFRA_DIR}"
  npx cdk destroy --all "${CDK_CONTEXT_ARGS[@]}" --force --profile "${AWS_PROFILE}"

  echo ""
  echo "== Checklist de validação pós-teardown (Console AWS / us-east-1):"
  echo "  [ ] CloudFormation: stack alvaro-agentic-payments-stack removida (DELETE_COMPLETE)."
  echo "  [ ] DynamoDB: tabelas alvaro-usuarios, alvaro-intencoes e alvaro-conversas ausentes."
  echo "  [ ] Cognito: User Pool alvaro-user-pool removido."
  echo "  [ ] API Gateway: REST API alvaro-chat-api removida."
  echo "  [ ] Lambda: funções alvaro-* removidas."
  echo "  [ ] Bedrock AgentCore: runtime alvaro_payment_agent removido."
  echo "  [ ] S3 / CloudFront (se --with-cloudfront): bucket alvaro-frontend-bucket-* e distribuição removidos."
  exit 0
fi

if [[ "${WITH_CLOUDFRONT}" == "true" ]]; then
  echo "== [1/4] Preparando build inicial do frontend React (Vite)..."
  npm --prefix "${FRONTEND_DIR}" run build
else
  echo "== [1/4] Modo padrão ativo: backend e Cognito na AWS + frontend local (http://localhost:5173)."
fi

echo "== [2/4] Validando tipos TypeScript da infraestrutura (infra/)..."
npm --prefix "${INFRA_DIR}" run build

echo "== [3/4] Executando cdk deploy --all em us-east-1..."
cd "${INFRA_DIR}"
npx cdk deploy --all \
  "${CDK_CONTEXT_ARGS[@]}" \
  --require-approval never \
  --outputs-file "${OUTPUTS_FILE}" \
  --profile "${AWS_PROFILE}"

echo "== [4/4] Gerando frontend/.env.local a partir dos outputs reais do CDK..."
write_frontend_env_from_outputs

if [[ "${WITH_CLOUDFRONT}" == "true" ]]; then
  echo "== Recompilando frontend com os outputs reais e publicando no S3 + CloudFront..."
  npm --prefix "${FRONTEND_DIR}" run build
  npx cdk deploy --all \
    "${CDK_CONTEXT_ARGS[@]}" \
    --require-approval never \
    --outputs-file "${OUTPUTS_FILE}" \
    --profile "${AWS_PROFILE}"
else
  echo "== Backend e Cognito prontos na AWS. Inicie o frontend local com:"
  echo "   npm --prefix frontend run dev"
fi

echo "== Deploy concluído. Outputs salvos em infra/cdk-outputs.json."
