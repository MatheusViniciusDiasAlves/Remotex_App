# Implantação, build e distribuição

## 0. Instalação automática no computador local

| | Windows 10/11 | Linux (Ubuntu/Debian) |
|---|---|---|
| Instalador | `scripts\instalar-windows.ps1` | `scripts/instalar-linux.sh` |
| Iniciar | `scripts\iniciar-local.ps1` (`-SoServidor`, `-SoHost`) | `scripts/iniciar-local.sh` (`--so-servidor`) |
| Programas | winget: Git, Node.js LTS, PostgreSQL 16 | apt: Git, Node.js 22 (NodeSource, se faltar), PostgreSQL, bibliotecas do Electron |
| Extras | `-ComAndroid` (Android Studio + JDK 17), `-ComDocker` (Docker Desktop) | `--testes` (Xvfb, openbox, Playwright), `--android` (ferramentas do `build-apk.sh`), `--docker`, `--tudo` |

O que o instalador faz, nesta ordem:

1. Instala só o que estiver faltando (Node.js precisa ser 20 ou mais novo).
2. Se não estiver dentro do projeto, clona o repositório em `~/Remotex_App`.
3. `npm ci` na raiz e em `windows-host/`, e garante o binário do Electron.
4. Cria no PostgreSQL o usuário e o banco **`remotex_local`** com senha aleatória. No Linux com
   `--testes`, cria também o usuário `remotex` (senha `remotex`) e o banco `remotex_test`, usados por
   `scripts/with-test-db.sh`.
5. Grava **`.env.local`** (fora do Git) com `DATABASE_URL`, `JWT_SECRET` e `PORT=8080`. Numa nova
   execução os segredos existentes são mantidos.
6. Compila servidor, app web e RemoteX Host e aplica as migrações.
7. Windows: libera a porta 8080 no Firewall (rede privada) para o celular conectar pela Wi-Fi
   (`-SemFirewall` para não mexer).

Observações:

- **Windows**: se o PostgreSQL for instalado agora, a senha do usuário `postgres` é gerada e guardada
  em `.env.local` (`POSTGRES_SUPERUSER_PASSWORD`); se ele já existia, o script pergunta a senha (ou use
  `-SenhaPostgres`). Se o winget faltar, instale o "Instalador de Aplicativo" pela Microsoft Store.
  Os testes de integração e E2E dependem de X11/Xvfb e rodam no Linux; no Windows use `npm test`.
- **Linux**: os testes de integração/E2E como usuário comum precisam do banco já criado:
  `export REMOTEX_USE_EXISTING_DB=1 DATABASE_URL=postgres://remotex:remotex@127.0.0.1:5432/remotex_test`.
- Os arquivos `.ps1` são salvos com BOM UTF-8 (o Windows PowerShell 5.1 precisa dele para ler os
  acentos); por isso a instalação em uma linha usa `.TrimStart([char]0xFEFF)`.

## 1. Servidor (internet) — Docker Compose

Requisitos: um servidor Linux com IP público, um domínio apontando para ele e as portas
**80/443 TCP** (HTTPS), **3478 TCP/UDP** e **5349 TCP** (TURN) e **49160–49999 UDP** (relay) abertas.

```bash
cd deploy
cp .env.example .env          # preencha DOMAIN, PUBLIC_IP e os segredos (openssl rand -hex 32)
docker compose --env-file .env up -d --build
curl https://SEU_DOMINIO/api/health
```

Serviços: `db` (PostgreSQL 16), `remotex` (API + sinalização + app web), `turn` (coturn com
credenciais temporárias) e `caddy` (HTTPS automático com Let's Encrypt). Migrações do banco são
aplicadas automaticamente na inicialização (`AUTO_MIGRATE=false` para desativar e usar
`npm run db:migrate`).

Coloque o instalador e o APK em `deploy/downloads/` para disponibilizá-los em
`https://SEU_DOMINIO/download/`.

### Variáveis de ambiente do servidor

| Variável | Padrão | Descrição |
|---|---|---|
| `DATABASE_URL` | — (obrigatória) | `postgres://usuario:senha@host:5432/remotex` |
| `JWT_SECRET` | aleatório em dev; obrigatória em produção | 32+ caracteres |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Endereço do servidor |
| `TRUST_PROXY` | `false` | `true` atrás do Caddy/nginx (IP real dos clientes) |
| `STUN_URLS` / `TURN_URLS` | vazio | Listas separadas por vírgula |
| `TURN_SECRET` / `TURN_TTL` | — / `21600` | Segredo compartilhado com o coturn; validade das credenciais (s) |
| `PUBLIC_DIR` | `android-app/web/dist` | App web do celular servido em `/` |
| `DOWNLOADS_DIR` | — | Pasta servida em `/download/` |
| `ALLOW_REGISTRATION` | `true` | Permitir criar contas |
| `CORS_ORIGINS` | `*` | Origens permitidas na API (tokens não usam cookies) |

### Rede local (teste rápido sem internet)

No próprio PC ou em outro computador da rede:

```bash
npm ci && npm run build
# PostgreSQL local já instalado:
DATABASE_URL=postgres://remotex:senha@127.0.0.1:5432/remotex npm start
```

No RemoteX Host: **Configurações → Servidor** = `http://IP_DO_SERVIDOR:8080`.
No celular: **Ajustes → Servidor** = o mesmo endereço (o app Android aceita `http://` na rede local).
Na mesma rede Wi-Fi a mídia trafega direto entre PC e celular, sem TURN.

## 2. Instalador Windows (RemoteX Host)

```bash
cd windows-host
npm ci
npm run dist:win          # → release/RemoteX-Host-Setup-1.0.0.exe + latest.yml
```

- Pode ser gerado no Windows (recomendado) ou em Linux com Wine instalado.
- Assinatura Authenticode: defina `CSC_LINK` (arquivo .pfx ou base64) e `CSC_KEY_PASSWORD`.
- O instalador é por usuário, não exige administrador, permite escolher a pasta, cria atalhos e
  oferece abrir o programa ao final. O servidor padrão é definido na primeira execução
  (`Configurações → Servidor`) ou pela variável `REMOTEX_SERVER`.

## 3. APK Android

**Com Android Studio** (recomendado para publicar na Play Store):

```bash
cd android-app
./gradlew assembleRelease -PremotexServer=https://SEU_DOMINIO
```

**Sem SDK do Google** (CI/Linux): usa ferramentas do Ubuntu e o compilador Kotlin oficial.

```bash
sudo apt-get install -y aapt dalvik-exchange zipalign apksigner android-sdk-platform-23 openjdk-17-jdk
REMOTEX_SERVER=https://SEU_DOMINIO bash android-app/tools/build-apk.sh
# APK de distribuição: RELEASE_KEYSTORE=... RELEASE_KEY_ALIAS=... RELEASE_KEYSTORE_PASS=...
```

Requisitos do APK: Android 8.0+ (API 26), alvo API 34.

## 4. CI (GitHub Actions)

`.github/workflows/ci.yml` executa: verificação de tipos, testes unitários, integração com
PostgreSQL, teste ponta a ponta (Xvfb), build do APK e, em `windows-latest`, testes do injetor
`SendInput` em Windows real e geração do instalador. Os artefatos ficam disponíveis no run.

## 5. Operação

- Backup: volume `db-data` (PostgreSQL). Os dados dos PCs (senha, dispositivos confiáveis) ficam no
  próprio computador, cifrados com DPAPI.
- Escala: uma instância atende milhares de conexões de sinalização; a mídia não passa por ela.
  Para várias instâncias, mova limitadores/presença para Redis (interfaces em `security/` e
  `signaling-server/`).
- Monitoramento: `GET /api/health`, `GET /api/admin/stats`, logs do container e `audit_log`.
