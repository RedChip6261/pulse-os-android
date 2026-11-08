#!/usr/bin/env bash
# Starts the Pulse OS backend in the background and makes port 3000 public.
set -u
cd "$(dirname "$0")/../server"

PORT="${PORT:-3000}"
LOG=/tmp/pulse-backend.log

[ -d node_modules ] || npm install --no-audit --no-fund

# Restart cleanly if it's already running (e.g. after a Codespace resume).
pkill -f "node server.js" 2>/dev/null || true
nohup node server.js > "$LOG" 2>&1 &

# Wait for the health check.
for i in $(seq 1 30); do
  curl -fs "http://localhost:${PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done

# Public visibility so the phone can reach it without a GitHub login.
if [ -n "${CODESPACE_NAME:-}" ]; then
  gh codespace ports visibility "${PORT}:public" -c "$CODESPACE_NAME" >/dev/null 2>&1 \
    && echo "Port ${PORT} is public." \
    || echo "Could not set port ${PORT} public automatically. Ports tab -> right-click ${PORT} -> Port Visibility -> Public."
  DOMAIN="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  URL="https://${CODESPACE_NAME}-${PORT}.${DOMAIN}"
else
  URL="http://localhost:${PORT}"
fi

echo ""
echo "=============================================="
echo " Pulse OS backend is running"
echo " Paste this into the app (Settings > Cloud):"
echo "   ${URL}"
echo " Codespace name (also accepted by the app):"
echo "   ${CODESPACE_NAME:-local}"
echo " Logs: tail -f ${LOG}"
echo "=============================================="
