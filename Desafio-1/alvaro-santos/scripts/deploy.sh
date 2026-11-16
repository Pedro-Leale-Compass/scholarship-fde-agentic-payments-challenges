#!/usr/bin/env bash
# =============================================================================
# Pipeline de Deploy em Comando Único e Teardown — Desafio 1 (AWS Cloud)
#
# Executa o ciclo completo da infraestrutura CDK em us-east-1 (conta 006739439488):
#   - Modo padrão: compila o frontend React, compila a stack CDK, faz deploy
#     completo (incluindo S3 privado + CloudFront OAC + BucketDeployment) e
#     invalida o cache do CloudFront em /*.
#   - Modo --skip-frontend: ativa -c skipFrontendHost=true para deploy apenas
#     do backend com CORS liberado para http://localhost:5173 (contorno temporário
#     caso cloudfront:* esteja bloqueado na conta compartilhada).
#   - Modo --destroy: executa cdk destroy --all e exibe o checklist de teardown.
#
# Uso:
#   bash scripts/deploy.sh [--skip-frontend] [--destroy] [--profile <perfil>]
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_DIR="${PROJECT_ROOT}/infra"
FRONTEND_DIR="${PROJECT_ROOT}/frontend"

AWS_PROFILE="${AWS_PROFILE:-alvaro-fellowship}"
SKIP_FRONTEND=false
DESTROY_MODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-frontend)
      SKIP_FRONTEND=true
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
if [[ "${SKIP_FRONTEND}" == "true" ]]; then
  CDK_CONTEXT_ARGS+=(-c "skipFrontendHost=true")
fi

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
  echo "  [ ] S3 / CloudFront (se aplicável): bucket alvaro-frontend-bucket-* e distribuição removidos."
  exit 0
fi

if [[ "${SKIP_FRONTEND}" == "false" ]]; then
  echo "== [1/3] Compilando frontend React (Vite)..."
  npm --prefix "${FRONTEND_DIR}" run build
else
  echo "== [1/3] Pulando build/hospedagem do frontend (--skip-frontend ativo; CORS para http://localhost:5173)."
fi

echo "== [2/3] Validando tipos TypeScript da infraestrutura (infra/)..."
npm --prefix "${INFRA_DIR}" run build

echo "== [3/3] Executando cdk deploy --all em us-east-1..."
cd "${INFRA_DIR}"
npx cdk deploy --all \
  "${CDK_CONTEXT_ARGS[@]}" \
  --require-approval never \
  --outputs-file cdk-outputs.json \
  --profile "${AWS_PROFILE}"

echo "== Deploy concluído. Outputs salvos em infra/cdk-outputs.json."
