# Implantação, build e distribuição

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
