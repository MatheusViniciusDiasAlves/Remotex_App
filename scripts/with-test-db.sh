#!/usr/bin/env bash
# Garante um PostgreSQL local com o banco "remotex_test" e executa o comando informado com
# DATABASE_URL apontando para ele. Usado pelos testes de integração e E2E.
set -euo pipefail

# Banco já fornecido (ex.: serviço PostgreSQL do CI): usa como está.
if [ -n "${DATABASE_URL:-}" ] && [ "${REMOTEX_USE_EXISTING_DB:-0}" = "1" ]; then
  exec "$@"
fi

DB_NAME="${REMOTEX_TEST_DB:-remotex_test}"
DB_USER="${REMOTEX_TEST_DB_USER:-remotex}"
DB_PASS="${REMOTEX_TEST_DB_PASS:-remotex}"

if ! pg_isready -q -h 127.0.0.1 2>/dev/null; then
  if command -v pg_ctlcluster >/dev/null 2>&1; then
    ver="$(ls /usr/lib/postgresql | sort -V | tail -1)"
    pg_ctlcluster "$ver" main start 2>/dev/null || true
  fi
  for _ in $(seq 1 30); do pg_isready -q -h 127.0.0.1 && break; sleep 0.5; done
fi

run_psql() {
  if [ "$(id -u)" = "0" ] && id postgres >/dev/null 2>&1; then
    printf '%s\n' "$1" | su postgres -c "psql -v ON_ERROR_STOP=1 -q -tA"
  else
    printf '%s\n' "$1" | psql -v ON_ERROR_STOP=1 -q -tA
  fi
}

run_psql "DO \$\$BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${DB_USER}') THEN CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}'; END IF; END\$\$;"
if [ "${REMOTEX_KEEP_DB:-0}" != "1" ]; then
  run_psql "DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);"
fi
if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'\"" 2>/dev/null | grep -q 1; then
  run_psql "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"
fi

export DATABASE_URL="postgres://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}"
exec "$@"
