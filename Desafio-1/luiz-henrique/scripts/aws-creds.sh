#!/usr/bin/env bash
# Exporta as credenciais do perfil AWS para o ambiente atual (eval).
#
# O perfil `desafio-1` usa o novo login do AWS CLI (login_session), que o SDK
# JavaScript não resolve sozinho. Este script converte a sessão em variáveis
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN.
#
# Uso:
#   eval "$(./scripts/aws-creds.sh)"
#   AWS_PROFILE=outro-perfil eval "$(./scripts/aws-creds.sh)"

set -euo pipefail

PROFILE="${AWS_PROFILE:-desafio-1}"

if ! aws configure export-credentials --profile "$PROFILE" --format env 2>/dev/null; then
  echo "echo 'ERRO: sem credenciais para o perfil $PROFILE. Rode: aws sso login --profile $PROFILE' >&2" >&2
  exit 1
fi

echo "export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_CREDENTIAL_EXPIRATION"
echo "export AWS_REGION=us-east-1"
echo "export AWS_DEFAULT_REGION=us-east-1"
