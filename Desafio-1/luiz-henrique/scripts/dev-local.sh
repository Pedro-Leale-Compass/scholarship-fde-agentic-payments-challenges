#!/usr/bin/env bash
# Sobe o frontend local.
# - Se infra/cdk-outputs.json existir (nosso ambiente), regenera config.json e usa a API atual.
# - Caso contrário (clone do instrutor), usa o config.json versionado.
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -f "$BASE_DIR/infra/cdk-outputs.json" ]]; then
  exec bash "$BASE_DIR/scripts/dev-frontend-local.sh"
fi

if [[ ! -f "$BASE_DIR/frontend/public/config.json" ]]; then
  echo "ERRO: frontend/public/config.json ausente."
  exit 1
fi

if [[ ! -d "$BASE_DIR/frontend/node_modules" ]]; then
  echo "ERRO: dependências do frontend não instaladas."
  echo "Rode: npm --prefix frontend install"
  exit 1
fi

cd "$BASE_DIR/frontend"
exec npm run dev