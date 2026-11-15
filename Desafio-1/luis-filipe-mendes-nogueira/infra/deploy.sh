#!/usr/bin/env bash
set -euo pipefail

DIRETORIO_INFRA="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PERFIL_DEPLOY="${1:-luisfilipe}"

cd "$DIRETORIO_INFRA"
source .venv/bin/activate

cdk deploy luis-filipe-mendes-nogueira-desafio-1 \
  --profile "$PERFIL_DEPLOY" \
  --outputs-file "$DIRETORIO_INFRA/cdk.out/outputs.json"

python "$DIRETORIO_INFRA/scripts/seed_catalogo.py" \
  --profile "$PERFIL_DEPLOY" \
  --outputs-file "$DIRETORIO_INFRA/cdk.out/outputs.json"