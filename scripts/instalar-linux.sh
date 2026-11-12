#!/usr/bin/env bash
# =============================================================================================
# Instala no Linux (Ubuntu/Debian) tudo o que o RemoteX precisa para rodar e desenvolver.
#
#   bash scripts/instalar-linux.sh                 # Node.js, PostgreSQL, Git, libs do Electron
#   bash scripts/instalar-linux.sh --testes        # + Xvfb/openbox/Playwright (integração e E2E)
#   bash scripts/instalar-linux.sh --android       # + ferramentas para gerar o APK sem Android Studio
#   bash scripts/instalar-linux.sh --docker        # + Docker e docker compose (deploy/)
#   bash scripts/instalar-linux.sh --tudo          # tudo acima
#
# Sem o projeto ainda (baixa em ~/Remotex_App):
#   bash <(curl -fsSL https://raw.githubusercontent.com/MatheusViniciusDiasAlves/Remotex_App/claude/laughing-fermi-nok1jq/scripts/instalar-linux.sh)
#
# Pode ser executado de novo: o que já existir é mantido. Gera .env.local (DATABASE_URL,
# JWT_SECRET, PORT), usado por scripts/iniciar-local.sh.
# =============================================================================================
set -euo pipefail

NODE_MINIMO=20
PORTA=8080
PASTA="${REMOTEX_PASTA:-$HOME/Remotex_App}"
BRANCH="${REMOTEX_BRANCH:-claude/laughing-fermi-nok1jq}"
REPO="${REMOTEX_REPO:-https://github.com/MatheusViniciusDiasAlves/Remotex_App.git}"
COM_TESTES=0 COM_ANDROID=0 COM_DOCKER=0

for arg in "$@"; do
  case "$arg" in
    --testes) COM_TESTES=1 ;;
    --android) COM_ANDROID=1 ;;
    --docker) COM_DOCKER=1 ;;
    --tudo) COM_TESTES=1 COM_ANDROID=1 COM_DOCKER=1 ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null || true; exit 0 ;;
    *) echo "Opção desconhecida: $arg (use --help)"; exit 2 ;;
  esac
done

etapa() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
ok() { printf '    \033[32mOK\033[0m  %s\n' "$*"; }
aviso() { printf '    \033[33m!!\033[0m  %s\n' "$*"; }
segredo() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }

if [ "$(id -u)" = "0" ]; then SUDO=""; else SUDO="sudo"; fi
command -v apt-get >/dev/null || { echo "Este script usa apt-get (Ubuntu/Debian). Em outra distribuição instale: Node.js >= $NODE_MINIMO, PostgreSQL, Git."; exit 1; }
export DEBIAN_FRONTEND=noninteractive

apt_tem() { apt-cache show "$1" >/dev/null 2>&1; }
apt_instalar() { $SUDO apt-get install -y -q --no-install-recommends "$@"; }

# ---------------------------------------------------------------------------------------------
# 1. Programas
# ---------------------------------------------------------------------------------------------
etapa "Pacotes do sistema"
$SUDO apt-get update -q
pacotes=(git curl ca-certificates unzip postgresql postgresql-client)
# Bibliotecas que o Electron (RemoteX Host) usa no Linux/X11
pacotes+=(libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgtk-3-0 libgbm1 libxss1 libxtst6 libxrandr2 libxdamage1 libxkbcommon0)
if apt_tem libasound2t64; then pacotes+=(libasound2t64); else pacotes+=(libasound2); fi
[ "$COM_TESTES" = 1 ] && pacotes+=(xvfb openbox x11-utils)
[ "$COM_ANDROID" = 1 ] && pacotes+=(aapt zipalign apksigner dalvik-exchange android-sdk-platform-23 openjdk-17-jdk-headless)
if [ "$COM_DOCKER" = 1 ]; then
  pacotes+=(docker.io)
  if apt_tem docker-compose-v2; then pacotes+=(docker-compose-v2); elif apt_tem docker-compose-plugin; then pacotes+=(docker-compose-plugin); fi
fi
apt_instalar "${pacotes[@]}"
ok "pacotes instalados"

etapa "Node.js (>= $NODE_MINIMO)"
versao_node() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' || echo 0; }
if [ "$(versao_node)" -ge "$NODE_MINIMO" ]; then
  ok "Node.js já instalado ($(node -v))"
else
  echo "    instalando Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
  apt_instalar nodejs
  [ "$(versao_node)" -ge "$NODE_MINIMO" ] || { echo "Falha ao instalar o Node.js >= $NODE_MINIMO"; exit 1; }
  ok "Node.js $(node -v)"
fi

if [ "$COM_DOCKER" = 1 ]; then
  etapa "Docker"
  $SUDO systemctl enable --now docker 2>/dev/null || $SUDO service docker start 2>/dev/null || aviso "não consegui iniciar o serviço docker"
  if [ -n "$SUDO" ] && ! id -nG "$USER" | grep -qw docker; then
    $SUDO usermod -aG docker "$USER" && aviso "seu usuário entrou no grupo docker: saia e entre na sessão para usar docker sem sudo"
  fi
  ok "Docker instalado"
fi

# ---------------------------------------------------------------------------------------------
# 2. Projeto
# ---------------------------------------------------------------------------------------------
etapa "Projeto RemoteX"
RAIZ=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  candidato="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  [ -f "$candidato/package.json" ] && [ -d "$candidato/windows-host" ] && RAIZ="$candidato"
fi
if [ -z "$RAIZ" ] && [ -f package.json ] && [ -d windows-host ]; then RAIZ="$(pwd)"; fi
if [ -z "$RAIZ" ]; then
  if [ -d "$PASTA/.git" ]; then ok "projeto já baixado em $PASTA"
  else
    echo "    baixando $REPO ($BRANCH) para $PASTA"
    git clone --branch "$BRANCH" "$REPO" "$PASTA"
  fi
  RAIZ="$PASTA"
fi
cd "$RAIZ"
ok "pasta do projeto: $RAIZ"

etapa "Dependências npm (servidor e app web)"
npm ci --no-audit --no-fund
ok "node_modules da raiz"

etapa "Dependências npm (RemoteX Host / Electron)"
npm --prefix windows-host ci --no-audit --no-fund
# Garante o binário do Electron (o postinstall às vezes não baixa, ex.: atrás de proxy).
node windows-host/node_modules/electron/install.js
[ -x windows-host/node_modules/electron/dist/electron ] || { echo "O Electron não foi baixado."; exit 1; }
ok "Electron pronto"

if [ "$COM_TESTES" = 1 ]; then
  etapa "Playwright (navegador do celular emulado no teste ponta a ponta)"
  npm install --no-save --no-audit --no-fund playwright@1.63.0
  npx playwright install --with-deps chromium
  ok "Playwright + Chromium"
fi

# ---------------------------------------------------------------------------------------------
# 3. Banco de dados
# ---------------------------------------------------------------------------------------------
etapa "PostgreSQL"
if ! pg_isready -q -h 127.0.0.1; then
  $SUDO systemctl enable --now postgresql 2>/dev/null \
    || $SUDO service postgresql start 2>/dev/null \
    || { ver="$(ls /usr/lib/postgresql | sort -V | tail -1)"; $SUDO pg_ctlcluster "$ver" main start; }
  for _ in $(seq 1 30); do pg_isready -q -h 127.0.0.1 && break; sleep 0.5; done
fi
pg_isready -q -h 127.0.0.1 || { echo "O PostgreSQL não respondeu em 127.0.0.1:5432"; exit 1; }
ok "PostgreSQL no ar"

ARQ_ENV="$RAIZ/.env.local"
ler_env() { [ -f "$ARQ_ENV" ] && sed -n "s/^$1=//p" "$ARQ_ENV" | tail -1 || true; }
SENHA_DB="$(ler_env REMOTEX_DB_PASSWORD)"
JWT="$(ler_env JWT_SECRET)"
[[ "$SENHA_DB" =~ ^[0-9a-f]+$ ]] || SENHA_DB="$(segredo 16)"
[ -n "$JWT" ] || JWT="$(segredo 32)"

psql_admin() {
  if [ -z "$SUDO" ]; then su postgres -c "psql -v ON_ERROR_STOP=1 -q -tA -c \"$1\""
  else sudo -u postgres psql -v ON_ERROR_STOP=1 -q -tA -c "$1"; fi
}
garantir_usuario() {  # nome senha
  if [ "$(psql_admin "SELECT 1 FROM pg_roles WHERE rolname='$1'")" = "1" ]; then
    psql_admin "ALTER ROLE $1 WITH LOGIN PASSWORD '$2'"; ok "usuário $1 atualizado"
  else
    psql_admin "CREATE ROLE $1 WITH LOGIN PASSWORD '$2'"; ok "usuário $1 criado"
  fi
}
garantir_banco() {  # nome dono
  if [ "$(psql_admin "SELECT 1 FROM pg_database WHERE datname='$1'")" = "1" ]; then ok "banco $1 já existe"
  else psql_admin "CREATE DATABASE $1 OWNER $2"; ok "banco $1 criado"; fi
}
# App local: usuário/banco próprios, senha aleatória.
garantir_usuario remotex_local "$SENHA_DB"
garantir_banco remotex_local remotex_local
# Testes: scripts/with-test-db.sh usa o usuário remotex com senha "remotex" e recria remotex_test.
if [ "$COM_TESTES" = 1 ]; then
  garantir_usuario remotex remotex
  garantir_banco remotex_test remotex
fi

umask 077
cat > "$ARQ_ENV" <<EOF
# Gerado por scripts/instalar-linux.sh — NÃO versionar (está no .gitignore).
# Lido por scripts/iniciar-local.sh.
DATABASE_URL=postgres://remotex_local:$SENHA_DB@127.0.0.1:5432/remotex_local
JWT_SECRET=$JWT
PORT=$PORTA
REMOTEX_DB_PASSWORD=$SENHA_DB
EOF
umask 022
ok ".env.local gravado (DATABASE_URL, JWT_SECRET, PORT)"

# ---------------------------------------------------------------------------------------------
# 4. Build e migrações
# ---------------------------------------------------------------------------------------------
etapa "Compilando servidor, app web e RemoteX Host"
npm run build
npm --prefix windows-host run build
ok "build concluído"

etapa "Migrações do banco"
DATABASE_URL="postgres://remotex_local:$SENHA_DB@127.0.0.1:5432/remotex_local" node dist/server/migrate.js
ok "banco atualizado"

# ---------------------------------------------------------------------------------------------
# Resumo
# ---------------------------------------------------------------------------------------------
ips="$(hostname -I 2>/dev/null || true)"
printf '\n\033[32m============================================================\n RemoteX pronto para uso local\n============================================================\033[0m\n'
echo " Pasta:     $RAIZ"
echo " Iniciar:   bash scripts/iniciar-local.sh        (servidor + RemoteX Host)"
echo "            bash scripts/iniciar-local.sh --so-servidor"
for ip in $ips; do case "$ip" in *:*|127.*) ;; *) echo " Celular:   http://$ip:$PORTA  (mesma rede)";; esac; done
echo " Testes:    npm test"
if [ "$COM_TESTES" = 1 ]; then
  if [ -z "$SUDO" ]; then echo "            npm run test:integration && npm run test:e2e"
  else
    echo "            export REMOTEX_USE_EXISTING_DB=1 DATABASE_URL=postgres://remotex:remotex@127.0.0.1:5432/remotex_test"
    echo "            npm run test:integration && npm run test:e2e"
  fi
fi
[ "$COM_ANDROID" = 1 ] && echo " APK:       bash android-app/tools/build-apk.sh"
[ "$COM_DOCKER" = 1 ] && echo " Docker:    cd deploy && cp .env.example .env && docker compose --env-file .env up -d --build"
exit 0
