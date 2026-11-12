#!/usr/bin/env bash
# Local dev setup for Desafio 1 (luiz-henrique) — sem AWS
#
# Portas 303X:
#   - llama.cpp:   1203  (precisa estar rodando via dev-tools/docker compose)
#   - Agent:       3031  (BedrockAgentCoreApp + llama.cpp)
#   - API:         3032  (JWT mock + /chat → invoca Agent)
#   - Frontend:    3033  (Next.js + Authenticator mock + chat)
#
# Uso:
#   npm run dev:local   (ou ./scripts/local-dev-setup.sh)
#
# Pressione Ctrl+C para parar todos os serviços.

set -euo pipefail

export AWS_PROFILE=local
export LOCAL_DEV=true
export AWS_DEFAULT_REGION=us-east-1
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="$BASE_DIR/agent"
API_DIR="$BASE_DIR/api/local"
FRONTEND_DIR="$BASE_DIR/frontend"

PIDS=()

cleanup() {
  echo ""
  echo "==> Parando serviços..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo "   Todos os serviços parados."
  exit 0
}
trap cleanup INT TERM

echo "============================================="
echo "  Desafio 1 — Dev Local (sem AWS)"
echo "============================================="
echo ""

echo "==> Verificando llama.cpp na porta 1203..."
if curl -s http://localhost:1203/health > /dev/null 2>&1; then
  echo "   OK llama.cpp em http://localhost:1203"
else
  echo "   WARN llama.cpp nao respondeu em http://localhost:1203"
  echo "       Inicie com: cd dev-tools && docker compose up"
fi

echo ""
echo "==> Iniciando Agent (porta 3031)..."
cd "$AGENT_DIR"
nohup npx tsx index.ts > /tmp/desafio-1-agent.log 2>&1 &
AGENT_PID=$!
PIDS+=("$AGENT_PID")
sleep 3
if curl -s -X POST http://localhost:3031/invocations \
  -H "Content-Type: application/json" \
  -H "x-amzn-bedrock-agentcore-runtime-session-id: health" \
  -d '{"prompt":"health","usuario_id":"health"}' > /dev/null 2>&1; then
  echo "   OK Agent em http://localhost:3031 (PID $AGENT_PID)"
else
  echo "   WARN Agent pode nao estar pronto. Veja /tmp/desafio-1-agent.log"
fi

echo ""
echo "==> Iniciando API local (porta 3032)..."
cd "$API_DIR"
nohup npx tsx index.ts > /tmp/desafio-1-api.log 2>&1 &
API_PID=$!
PIDS+=("$API_PID")
sleep 3
if curl -s http://localhost:3032/health > /dev/null 2>&1; then
  echo "   OK API em http://localhost:3032 (PID $API_PID)"
else
  echo "   WARN API pode nao estar pronta. Veja /tmp/desafio-1-api.log"
fi

echo ""
echo "==> Iniciando Frontend (porta 3033)..."
cd "$FRONTEND_DIR"
export NEXT_PUBLIC_API_URL=http://localhost:3032
export NEXT_PUBLIC_LOCAL_DEV=true
nohup npm run dev -- -p 3033 > /tmp/desafio-1-frontend.log 2>&1 &
FRONTEND_PID=$!
PIDS+=("$FRONTEND_PID")
sleep 5
if curl -s http://localhost:3033 > /dev/null 2>&1; then
  echo "   OK Frontend em http://localhost:3033 (PID $FRONTEND_PID)"
else
  echo "   WARN Frontend pode nao estar pronto. Veja /tmp/desafio-1-frontend.log"
fi

echo ""
echo "============================================="
echo "  Ambiente local rodando!"
echo "============================================="
echo ""
echo "  Frontend:   http://localhost:3033"
echo "  API:        http://localhost:3032"
echo "  Agent:      http://localhost:3031"
echo "  llama.cpp:  http://localhost:1203"
echo ""
echo "  Usuarios de teste:"
echo "    <test-email> / Temp1234!"
echo "    maria@test.com / Temp1234!"
echo ""
echo "  Logs:"
echo "    tail -f /tmp/desafio-1-agent.log"
echo "    tail -f /tmp/desafio-1-api.log"
echo "    tail -f /tmp/desafio-1-frontend.log"
echo ""
echo "  Pressione Ctrl+C para parar tudo."
echo ""

# Spin keeping the script alive; background children keep running
while true; do
  sleep 60
done
