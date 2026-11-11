# Testes

| Suíte | Comando | O que cobre | Resultado atual |
|---|---|---|---|
| Unitários | `npm test` | IDs, codificação, permissões, limitadores, senha scrypt/HMAC, Ed25519, amarração DTLS, mapa de teclas, despachante de entrada, gestos, touchpad, diff do IME, qualidade adaptativa, codecs, estatísticas, gravação, layout binário do `SendInput` | 58 ✅ (+3 só em Windows) |
| Integração | `npm run test:integration` | API + sinalização com PostgreSQL e WebSocket reais (registro, presença, relay, intrusos, limites, contas, refresh rotativo, bloqueio de login, revogação); injetor XTest num servidor X | 14 ✅ |
| Ponta a ponta | `npm run test:e2e` | Servidor + PostgreSQL + **host Electron real** sob Xvfb + **celular emulado** (Chromium, Pixel 7, toque) | 25/25 ✅ |
| Windows real | CI `windows-latest` | `SendInput` move o cursor e `GetCursorPos` confirma; roda/teclas/privilégios/caret | aguardando execução do CI |

## O teste ponta a ponta

`tests/e2e/remote-control.e2e.mjs` sobe tudo de verdade e usa um aplicativo-alvo em tela cheia que
registra cada evento recebido pelo "computador". Etapas:

- Host inicia, registra-se e fica online; celular pede acesso; janela de aprovação aparece no PC.
- Vídeo real 1280×800 chega ao celular; códigos de verificação iguais nos dois lados.
- Toque = clique no pixel exato; texto `Olá RemoteX! ação ç 123` digitado no PC; Backspace, Enter,
  Ctrl+A e setas; toque longo = clique direito; duplo toque; arrastar com botão; rolagem com 2 dedos;
  modo Mouse (cursor relativo, clique no cursor, botão direito da barra); pinça com proporção
  preservada e clique preciso com zoom; resolução original 1:1; área de transferência celular→PC;
  aviso de Ctrl+Alt+Del; **latência ida-e-volta medida pelo vídeo**; gravação MP4 no PC com
  indicadores; painel admin remoto; desconexão nos dois lados.
- Senha: errada recusada, correta conecta; senha lembrada reconecta sem digitar.
- Dispositivo confiável reconecta sozinho (Ed25519).
- Recusa informada ao celular; conexões desativadas bloqueiam pedidos.

Artefatos (relatório JSON, logs e capturas) em `tests/e2e/.artifacts/`.

Requisitos locais: Node 22, PostgreSQL, Xvfb, Openbox (gerenciador de janelas para foco ao clicar,
como no Windows), Chromium do Playwright.

## Roteiro manual em dispositivos reais

1. Suba o servidor (Docker Compose ou `npm start`) e instale o host num **Windows 10/11**.
2. Instale o APK num **Android 8+**; configure o mesmo servidor.
3. Conecte na mesma Wi-Fi (confira "Direta • rede local" no chip de qualidade) e via 4G/5G
   (deve aparecer "Direta • internet" ou "TURN").
4. Verifique: aprovação, senha, dispositivo confiável; Touch e Mouse; teclado com acentos; atalhos;
   abertura automática do teclado no Bloco de Notas; áudio do PC; microfone; gravação nos dois
   lados; monitores múltiplos; programa como administrador (aviso de UIPI e reinício via UAC).
5. Rede limitada: ative "Econômica" e observe FPS/bitrate no chip.
