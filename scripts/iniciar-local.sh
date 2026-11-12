#!/usr/bin/env bash
# Inicia o RemoteX localmente: servidor (API + sinalização + app web) e RemoteX Host.
#   bash scripts/iniciar-local.sh                # servidor + host
#   bash scripts/iniciar-local.sh --so-servidor  # só o servidor (Ctrl+C para parar)
# Lê .env.local, criado por scripts/instalar-linux.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

SO_SERVIDOR=0
[ "${1:-}" = "--so-servidor" ] && SO_SERVIDOR=1

[ -f .env.local ] || { echo ".env.local não encontrado. Execute antes: bash scripts/instalar-linux.sh"; exit 1; }
while IFS='=' read -r nome valor; do
  case "$nome" in ''|\#*|REMOTEX_DB_PASSWORD|POSTGRES_SUPERUSER_PASSWORD) continue ;; esac
  export "$nome=$valor"
done < .env.local
export PORT="${PORT:-8080}"
URL="http://127.0.0.1:$PORT"

[ -f dist/server/server.js ] || npm run build

if ! pg_isready -q -h 127.0.0.1 2>/dev/null; then
  if [ "$(id -u)" = 0 ]; then S=""; else S="sudo"; fi
  $S systemctl start postgresql 2>/dev/null || $S service postgresql start 2>/dev/null \
    || $S pg_ctlcluster "$(ls /usr/lib/postgresql | sort -V | tail -1)" main start || true
fi

if [ "$SO_SERVIDOR" = 1 ]; then exec node dist/server/server.js; fi

node dist/server/server.js &
SERVIDOR=$!
trap 'kill $SERVIDOR 2>/dev/null || true' EXIT INT TERM
for _ in $(seq 1 60); do curl -fs "$URL/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fs "$URL/api/health" >/dev/null || { echo "O servidor não respondeu em $URL"; exit 1; }
echo "==> servidor no ar em $URL"
for ip in $(hostname -I 2>/dev/null || true); do case "$ip" in *:*|127.*) ;; *) echo "    no celular (mesma rede): http://$ip:$PORT";; esac; done

echo "==> abrindo o RemoteX Host (feche a janela para encerrar tudo)"
export REMOTEX_SERVER="${REMOTEX_SERVER:-$URL}"
npm --prefix windows-host start
