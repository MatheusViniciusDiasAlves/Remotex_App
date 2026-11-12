# RemoteX

**Acesse e controle seu computador Windows pelo celular Android** — tela inteira em tempo real,
toque e touchpad, teclado nativo com acentos, atalhos, áudio, gravação e administração, com
autorização ponta a ponta e criptografia.

| Celular | Teclado remoto | Senha de acesso | Painel do computador | Aprovação |
|---|---|---|---|---|
| ![Início](documentation/imagens/phone-home.png) | ![Teclado](documentation/imagens/phone-keyboard.png) | ![Senha](documentation/imagens/phone-password.png) | ![Host](documentation/imagens/host-dashboard.png) | ![Aprovação](documentation/imagens/host-approval.png) |

*(capturas reais geradas pelo teste ponta a ponta)*

## Como funciona

1. Instale o **RemoteX Host** no computador → ele mostra um **ID de 9 dígitos**.
2. Abra o **app RemoteX** no celular, digite o ID e toque em **Conectar**.
3. O computador autoriza (aprovação na tela, senha de acesso ou dispositivo confiável).
4. A tela do PC aparece no celular e você controla mouse e teclado — na mesma Wi-Fi ou pela internet.

## Componentes

| Pasta | O que é |
|---|---|
| [`windows-host/`](windows-host) | Programa HOST para Windows (Electron + WebRTC + SendInput) |
| [`android-app/`](android-app) | App Android (Kotlin) + núcleo do cliente em TypeScript |
| [`backend/`](backend), [`signaling-server/`](signaling-server) | Servidor: API REST, sinalização WebSocket, PostgreSQL |
| `authentication/`, `security/`, `device-management/`, `remote-input/`, `media-engine/`, `screen-capture/`, `audio/`, `recording/`, `admin/`, `database/`, `shared/` | Módulos compartilhados |
| [`tests/`](tests) | Unitários, integração e ponta a ponta |
| [`deploy/`](deploy) | Docker Compose: PostgreSQL, servidor, TURN (coturn), HTTPS (Caddy) |
| [`documentation/`](documentation) | Documentação completa |

## Instalação automática no seu computador

Um script instala tudo o que falta (Git, Node.js, PostgreSQL), baixa as dependências, cria o banco,
compila e deixa pronto para iniciar. Pode ser executado de novo sem problemas.

**Windows** — no PowerShell (o Windows pedirá permissão de administrador para instalar os programas):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/MatheusViniciusDiasAlves/Remotex_App/claude/laughing-fermi-nok1jq/scripts/instalar-windows.ps1).TrimStart([char]0xFEFF)))
```

Ou, com o projeto já baixado: `powershell -ExecutionPolicy Bypass -File scripts\instalar-windows.ps1`
(opções: `-ComAndroid` instala Android Studio + JDK 17, `-ComDocker` instala o Docker Desktop).
Depois: `powershell -ExecutionPolicy Bypass -File scripts\iniciar-local.ps1` abre o servidor e o RemoteX Host.

**Linux (Ubuntu/Debian)**:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/MatheusViniciusDiasAlves/Remotex_App/claude/laughing-fermi-nok1jq/scripts/instalar-linux.sh)
```

Ou `bash scripts/instalar-linux.sh [--testes] [--android] [--docker] [--tudo]`; depois
`bash scripts/iniciar-local.sh`. Detalhes em [Implantação](documentation/IMPLANTACAO.md#0-instalação-automática-no-computador-local).

## Início rápido (desenvolvimento)

```bash
npm ci && npm --prefix windows-host ci
npm run build                                  # servidor + app web
DATABASE_URL=postgres://remotex:senha@127.0.0.1:5432/remotex npm start   # http://localhost:8080
npm --prefix windows-host start                # host (aponte para o servidor em Configurações)
```

Abra `http://IP_DO_SERVIDOR:8080` no navegador do celular (ou instale o APK) e conecte pelo ID.

## Builds

```bash
npm --prefix windows-host run dist:win         # instalador Windows (NSIS)
bash android-app/tools/build-apk.sh            # APK Android (ou ./gradlew assembleRelease)
cd deploy && docker compose --env-file .env up -d --build   # servidor em produção
```

## Testes

```bash
npm test                    # 58 testes unitários
npm run test:integration    # 14 testes com PostgreSQL, WebSocket e X11 reais
npm run test:e2e            # 25 etapas ponta a ponta: servidor + host + celular emulado
```

Latência medida no teste ponta a ponta: entrada 8–25 ms; ida-e-volta completa (toque → PC → imagem
de volta no celular) com mediana de 65–90 ms em rede local.

## Documentação

- [Arquitetura e decisões técnicas](documentation/ARQUITETURA.md)
- [Protocolos (REST, sinalização, canais de dados)](documentation/PROTOCOLO.md)
- [Segurança](documentation/SEGURANCA.md)
- [Implantação, builds e distribuição](documentation/IMPLANTACAO.md)
- [Manual do usuário](documentation/MANUAL_DO_USUARIO.md)
- [Testes](documentation/TESTES.md)
- [**Acompanhamento**: concluído, pendente, erros, limitações e próximas etapas](documentation/ACOMPANHAMENTO.md)
