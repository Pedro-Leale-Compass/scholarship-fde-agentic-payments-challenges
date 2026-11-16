#!/usr/bin/env bash
set -euo pipefail

DIRETORIO_INFRA="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PERFIL_DEPLOY="${1:-luisfilipe}"

# O CDK foi instalado no Node 24. O script também funciona em um shell
# novo, no qual o NVM ainda não foi carregado.
if ! command -v node >/dev/null 2>&1 || \
  [[ "$(node -p 'process.versions.node.split(".")[0]')" != "24" ]]; then
  ARQUIVO_NVM="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  if [[ ! -s "$ARQUIVO_NVM" ]]; then
    echo "Ative o Node 24 antes de executar este script." >&2
    exit 1
  fi
  source "$ARQUIVO_NVM"
  nvm use 24
fi

if ! command -v cdk >/dev/null 2>&1; then
  echo "CDK CLI não encontrado no Node 24." >&2
  exit 1
fi

cd "$DIRETORIO_INFRA"
source .venv/bin/activate

# O ZIP é sempre reconstruído antes da síntese feita pelo deploy.
# O CDK publica esse asset no bucket do bootstrap.
python "$DIRETORIO_INFRA/scripts/empacotar_agent.py"

cdk deploy luis-filipe-mendes-nogueira-desafio-1 \
  --profile "$PERFIL_DEPLOY" \
  --outputs-file "$DIRETORIO_INFRA/cdk.out/outputs.json"

python "$DIRETORIO_INFRA/scripts/seed_catalogo.py" \
  --profile "$PERFIL_DEPLOY" \
  --outputs-file "$DIRETORIO_INFRA/cdk.out/outputs.json"
