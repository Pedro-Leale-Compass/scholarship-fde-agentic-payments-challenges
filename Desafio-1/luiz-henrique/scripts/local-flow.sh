#!/usr/bin/env bash
# Sobe o agente local, executa o fluxo de duas compras e derruba o processo.
# Por padrão usa o fallback em memória (sem Lambda/DynamoDB).
#
# Uso:
#   npm run test:local
#   USE_REAL_TOOLS=1 npm run test:local   # usa as Lambdas implantadas
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3031}"
LOG_FILE="$(mktemp -t desafio1-local-flow.XXXXXX.log)"
PID=""

cleanup() {
  if [[ -n "$PID" ]]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

eval "$(bash "$BASE_DIR/scripts/aws-creds.sh")"
unset AWS_PROFILE

if [[ "${USE_REAL_TOOLS:-0}" != "1" ]]; then
  unset TOOL_LISTAR_CATALOGO_ARN TOOL_REGISTRAR_INTENCAO_ARN TOOL_REALIZAR_COMPRA_ARN
fi

export SALDO_INICIAL_LOCAL="${SALDO_INICIAL_LOCAL:-500}"
export PORT

echo "Subindo agente local na porta $PORT..."
(
  cd "$BASE_DIR/agent"
  npx tsx index.ts
) >"$LOG_FILE" 2>&1 &
PID=$!

ready=0
for _ in $(seq 1 40); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 \
    -X POST "http://localhost:$PORT/invocations" \
    -H 'content-type: application/json' \
    -H 'x-amzn-bedrock-agentcore-runtime-session-id: readiness' \
    -d '{}' 2>/dev/null || true)"
  if [[ "$code" != "000" ]]; then
    ready=1
    break
  fi
  sleep 1
done

if [[ "$ready" != "1" ]]; then
  echo "ERRO: agente local não subiu na porta $PORT." >&2
  tail -40 "$LOG_FILE" >&2 || true
  exit 1
fi

set +e
AGENT_LOCAL_URL="http://localhost:$PORT" node "$BASE_DIR/scripts/local-flow.mjs"
status=$?
set -e

if [[ "$status" -ne 0 ]]; then
  echo
  echo "--- log do agente (últimas 60 linhas) ---" >&2
  tail -60 "$LOG_FILE" >&2 || true
fi

exit "$status"
