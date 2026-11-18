#!/usr/bin/env bash
# Lista os log groups/streams do agente e das tools no CloudWatch.
# Somente leitura: não cria recursos nem gera custo de Bedrock.
#
# Uso:
#   npm run check:logs
#   AWS_PROFILE=desafio-1 npm run check:logs
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${AWS_PROFILE:-desafio-1}"
REGION="${AWS_REGION:-us-east-1}"
if ! aws sts get-caller-identity \
  --region "$REGION" \
  --profile "$PROFILE" \
  --output json >/dev/null 2>&1; then
  echo "ERRO: sem credenciais válidas para o perfil '$PROFILE'." >&2
  echo "Dica: aws sso login --profile $PROFILE" >&2
  exit 1
fi

prefixes=(
  "/aws/bedrock-agentcore"
  "/aws/lambda/luiz-henrique-"
)

found=0
for prefix in "${prefixes[@]}"; do
  groups="$(aws logs describe-log-groups \
    --log-group-name-prefix "$prefix" \
    --region "$REGION" \
    --profile "$PROFILE" \
    --query 'logGroups[].logGroupName' \
    --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)"
  [[ -z "$groups" ]] && continue
  while IFS= read -r group; do
    [[ -z "$group" ]] && continue
    found=1
    echo "== $group =="
    aws logs describe-log-streams \
      --log-group-name "$group" \
      --order-by LastEventTime \
      --descending \
      --limit 3 \
      --region "$REGION" \
      --profile "$PROFILE" \
      --query 'logStreams[].logStreamName' \
      --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true
    echo "-- últimos eventos (24h) --"
    aws logs tail "$group" \
      --since 24h \
      --format short \
      --region "$REGION" \
      --profile "$PROFILE" 2>/dev/null | tail -40 || true
    echo
  done <<< "$groups"
done

if [[ "$found" -eq 0 ]]; then
  echo "Nenhum log group encontrado para os prefixos:"
  printf '  %s\n' "${prefixes[@]}"
  echo
  echo "Isso não prova que o agente não loga: o console do AgentCore pode não"
  echo "mostrar o grupo. Verifique também /aws/lambda/luiz-henrique-* e o"
  echo "docs/OPERATIONS.md (seção Logs)."
fi

echo "Runtime configurado:"
"$BASE_DIR/scripts/check-model.sh" 2>/dev/null || echo "  (não foi possível consultar o runtime; veja check-model.sh)"
