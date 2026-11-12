#!/usr/bin/env bash
# Local test setup for Desafio 1 (luiz-henrique) — Desenvolvimento local sem AWS
#
# Orquestra três serviços locais nas portas 303X:
#   - Agent (porta 3031): BedrockAgentCoreApp + llama.cpp (inferência local)
#   - API  (porta 3032): HTTP server que chama o Agent + gera JWT mock
#   - Frontend (porta 3033): Next.js com Authenticator mock + chat
#
# Tudo roda localmente, sem credenciais AWS, sem AgentCore Runtime da AWS,
// sem MiniStack. Apenas llama.cpp na porta 1203 deve estar rodando.
#
# Uso:
#   ./scripts/local-dev-setup.sh   # inicia todos os serviços
#
# Requisitos:
#   - llama.cpp rodando em http://localhost:1203 (docker compose em dev-tools/)
#   - Docker não é necessário para o agent local (roda com tsx direto)

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

echo "============================================="
echo "  Desafio 1 — Ambiente Local de Desenvolvimento"
echo "============================================="
echo ""

echo "==> Verificando llama.cpp na porta 1203..."
if curl -s http://localhost:1203/health > /dev/null 2>&1; then
  echo "   ✓ llama.cpp disponível em http://localhost:1203"
else
  echo "   ⚠ llama.cpp não respondeu em http://localhost:1203"
  echo "     Inicie com: cd dev-tools && docker compose up"
  echo ""
  read -p "Continuar mesmo assim? (y/N) " -r
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

echo ""
echo "==> Iniciando Agent (porta 3031)..."
cd "$AGENT_DIR"
export AWS_PROFILE=local
export LOCAL_DEV=true
nohup npx tsx index.ts > /tmp/desafio-1-agent.log 2>&1 &
AGENT_PID=$!
sleep 3
if curl -s -X POST http://localhost:3031/invocations \
  -H "Content-Type: application/json" \
  -H "x-amzn-bedrock-agentcore-runtime-session-id: health" \
  -d '{"prompt":"health","usuario_id":"health"}' > /dev/null 2>&1; then
  echo "   ✓ Agent rodando em http://localhost:3031 (PID: $AGENT_PID)"
else
  echo "   ⚠ Agent pode não estar pronto. Verifique /tmp/desafio-1-agent.log"
fi

echo ""
echo "==> Iniciando API local (porta 3032)..."
cd "$API_DIR"
export LOCAL_DEV=true
export AWS_PROFILE=local
nohup npx tsx index.ts > /tmp/desafio-1-api.log 2>&1 &
API_PID=$!
sleep 3
if curl -s http://localhost:3032/health > /dev/null 2>&1; then
  echo "   ✓ API rodando em http://localhost:3032 (PID: $API_PID)"
else
  echo "   ⚠ API pode não estar pronta. Verifique /tmp/desafio-1-api.log"
fi

echo ""
echo "==> Iniciando Frontend (porta 3033)..."
cd "$FRONTEND_DIR"
export NEXT_PUBLIC_API_URL=http://localhost:3032
export NEXT_PUBLIC_LOCAL_DEV=true
nohup npm run dev -- -p 3033 > /tmp/desafio-1-frontend.log 2>&1 &
FRONTEND_PID=$!
sleep 5
if curl -s http://localhost:3033 > /dev/null 2>&1; then
  echo "   ✓ Frontend rodando em http://localhost:3033 (PID: $FRONTEND_PID)"
else
  echo "   ⚠ Frontend pode não estar pronto. Verifique /tmp/desafio-1-frontend.log"
fi

echo ""
echo "============================================="
echo "  Ambiente local pronto!"
echo "============================================="
echo ""
echo "  Acesse o frontend:  http://localhost:3033"
echo "  Usuários de teste:"
echo "    luiz.fsilva@desafio1.local / Temp1234!"
echo "    maria.silva@desafio1.local / Temp1234!"
echo ""
echo "  Endpoints diretos (para testes via curl):"
echo "    POST http://localhost:3032/auth/token   (gera JWT mock)"
echo "    POST http://localhost:3032/chat         (chama o agent)"
echo "    POST http://localhost:3031/invocations  (agent direto)"
echo ""
echo "  Logs:"
echo "    tail -f /tmp/desafio-1-agent.log"
echo "    tail -f /tmp/desafio-1-api.log"
echo "    tail -f /tmp/desafio-1-frontend.log"
echo ""
echo "  Para parar todos os serviços:"
echo "    pkill -f 'tsx index.ts'"
echo "    pkill -f 'next dev'"
echo ""
