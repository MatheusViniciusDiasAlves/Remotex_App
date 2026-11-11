#!/usr/bin/env bash
# Executa o teste ponta a ponta: build → Xvfb (tela virtual 1280x800) → PostgreSQL → teste.
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/build.mjs
(cd windows-host && node build.mjs)

DISPLAY_NUM="${E2E_DISPLAY:-:99}"
if ! xdpyinfo -display "$DISPLAY_NUM" >/dev/null 2>&1; then
  Xvfb "$DISPLAY_NUM" -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &
  XVFB_PID=$!
  trap 'kill $XVFB_PID 2>/dev/null || true' EXIT
  sleep 1
fi
export DISPLAY="$DISPLAY_NUM"

# Gerenciador de janelas (clique transfere o foco do teclado, como no Windows real).
if command -v openbox >/dev/null 2>&1 && ! pgrep -x openbox >/dev/null; then
  openbox >/dev/null 2>&1 &
  WM_PID=$!
  trap 'kill ${WM_PID:-0} ${XVFB_PID:-0} 2>/dev/null || true' EXIT
  sleep 0.5
fi

bash scripts/with-test-db.sh node tests/e2e/remote-control.e2e.mjs
