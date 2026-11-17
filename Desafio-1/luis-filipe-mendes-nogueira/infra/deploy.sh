#!/usr/bin/env bash
set -euo pipefail

DIRETORIO_INFRA="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DIRETORIO_RAIZ="$(cd -- "$DIRETORIO_INFRA/.." && pwd)"
PERFIL_DEPLOY="${1:-luisfilipe}"

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

for COMANDO_DEPLOY in npm cdk; do
  if ! command -v "$COMANDO_DEPLOY" >/dev/null 2>&1; then
    echo "Comando ausente: $COMANDO_DEPLOY" >&2
    exit 1
  fi
done

cd "$DIRETORIO_INFRA"
source .venv/bin/activate

npm --prefix "$DIRETORIO_RAIZ/api/chat" ci --include=dev
npm --prefix "$DIRETORIO_RAIZ/api/chat" test
npm --prefix "$DIRETORIO_RAIZ/api/chat" run build

python "$DIRETORIO_INFRA/scripts/empacotar_agent.py"

cdk deploy luis-filipe-mendes-nogueira-desafio-1 \
  --profile "$PERFIL_DEPLOY" \
  --outputs-file "$DIRETORIO_INFRA/cdk.out/outputs.json"

python "$DIRETORIO_INFRA/scripts/seed_catalogo.py" \
  --profile "$PERFIL_DEPLOY" \
  --outputs-file "$DIRETORIO_INFRA/cdk.out/outputs.json"

python "$DIRETORIO_INFRA/scripts/configurar_frontend.py" \
  --outputs-file "$DIRETORIO_INFRA/cdk.out/outputs.json"

npm --prefix "$DIRETORIO_RAIZ/frontend" ci --include=dev
npm --prefix "$DIRETORIO_RAIZ/frontend" test
npm --prefix "$DIRETORIO_RAIZ/frontend" run build

echo "Deploy concluído e frontend local gerado."
