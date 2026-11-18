#!/usr/bin/env bash
# Confirma, sem invocar o modelo, qual BEDROCK_MODEL_ID está configurado no
# AgentCore Runtime implantado. Leitura de control plane: não gera custo de Bedrock.
#
# Uso:
#   npm run check:model
#   AGENT_RUNTIME_ID=... AWS_PROFILE=desafio-1 npm run check:model
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${AWS_PROFILE:-desafio-1}"
REGION="${AWS_REGION:-us-east-1}"

runtime_id="${AGENT_RUNTIME_ID:-}"
if [[ -z "$runtime_id" && -f "$BASE_DIR/infra/cdk-outputs.json" ]]; then
  runtime_id="$(python3 - "$BASE_DIR/infra/cdk-outputs.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    data = json.load(fh)
stack = data.get("Desafio1Stack", data)
for key in ("AgentRuntimeId", "AgentStackAgentRuntimeIdE93B6B16", "AgentStackAgentRuntimeId"):
    value = stack.get(key)
    if value:
        print(value)
        break
PY
)"
fi

if [[ -z "$runtime_id" ]]; then
  echo "ERRO: AgentRuntimeId não encontrado. Rode o deploy ou defina AGENT_RUNTIME_ID." >&2
  exit 1
fi

echo "Runtime: $runtime_id"
echo "Perfil:  $PROFILE"
echo "Região:  $REGION"
echo

set +e
raw="$(aws bedrock-agentcore-control get-agent-runtime \
  --agent-runtime-id "$runtime_id" \
  --region "$REGION" \
  --profile "$PROFILE" \
  --output json 2>&1)"
status=$?
set -e

if [[ "$status" -ne 0 ]]; then
  echo "ERRO: não foi possível consultar o runtime." >&2
  printf '%s\n' "$raw" | tail -5 >&2
  echo "Dica: renove a sessão com 'aws sso login --profile $PROFILE' e tente de novo." >&2
  exit 1
fi

printf '%s\n' "$raw" |
python3 -c '
import json, sys
r = json.load(sys.stdin)
env = r.get("environmentVariables") or {}
model = env.get("BEDROCK_MODEL_ID")
print("status:              ", r.get("status"))
print("versão:              ", r.get("agentRuntimeVersion"))
print("atualizado em:       ", r.get("lastUpdatedAt"))
print("BEDROCK_MODEL_ID:    ", model or "(não configurado; o código usa global.amazon.nova-2-lite-v1:0)")
if model and "claude-haiku-4-5" in model:
    print("modelo confirmado:    Claude Haiku 4.5")
elif model:
    print("modelo confirmado:    NÃO é Claude Haiku 4.5")
else:
    print("modelo confirmado:    fallback Nova 2 Lite (padrão do código)")
'
