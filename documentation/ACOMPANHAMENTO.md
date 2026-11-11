# Acompanhamento do desenvolvimento — RemoteX

Última atualização: 11/11/2026 · Versão 1.0.0

## Resumo do estado

Versão funcional ponta a ponta: um celular conecta ao computador pelo ID, autoriza o acesso
(aprovação, senha ou dispositivo confiável), recebe a tela em tempo real e controla mouse, teclado,
rolagem, zoom, área de transferência, áudio, gravação e administração. Comprovado pelo teste ponta
a ponta automatizado (25 etapas, 3 execuções consecutivas sem falhas).

| Componente | Estado | Evidência |
|---|---|---|
| Backend (API + sinalização + PostgreSQL) | ✅ Concluído | 11 testes de integração com PostgreSQL e WebSocket reais |
| Host Windows (Electron) | ✅ Concluído (validado em Linux/Xvfb; ver limitações) | E2E 25/25; instalador NSIS gerado |
| Injeção de entrada Windows (SendInput) | ✅ Implementado · ⏳ validação em Windows real pendente | layout binário de `INPUT` validado byte a byte; FFI carregou no `.exe` Windows sob Wine; teste para `windows-latest` no CI |
| Cliente móvel (núcleo TypeScript) | ✅ Concluído | E2E com Chromium emulando Pixel 7 com toque |
| App Android (Kotlin) | ✅ Concluído · ⏳ teste em aparelho físico pendente | APK assinado (v2+v3), minSdk 26, alvo 34 |
| Instalador Windows | ✅ `RemoteX-Host-Setup-1.0.0.exe` (121 MB) + `latest.yml` | gerado com electron-builder |
| Implantação | ✅ Docker Compose (PostgreSQL, servidor, coturn, Caddy/HTTPS) | layout de produção executado localmente |
| Documentação | ✅ Arquitetura, protocolo, segurança, implantação, manual, testes | `documentation/` |

## Funcionalidades concluídas (por fase)

**Fase 1 — Arquitetura**: análise do ambiente, decisões justificadas em [ARQUITETURA.md](ARQUITETURA.md).

**Fase 2 — Host Windows**: ID de 9 dígitos com dígito verificador; status online/offline; painel
(Início, Segurança, Dispositivos confiáveis, Histórico, Gravações, Configurações); bandeja; janela de
aprovação; banner de sessão sempre visível; iniciar com o Windows (opcional, desligado); segundo
plano (opcional); desabilitar conexões; log em arquivo; configuração cifrada com DPAPI.

**Fase 3 — App Android**: telas Início (ID, favoritos com presença, recentes), Dispositivos (este
celular, conta, dispositivos da conta, computadores verificados), Histórico, Ajustes; shell Kotlin
com ponte nativa.

**Fase 4 — Identificação e conexão**: registro de dispositivos, presença, pedido por ID,
autenticação ponta a ponta (aprovação/senha/dispositivo), fixação da chave do PC, amarração DTLS,
código de verificação, contas opcionais com JWT e refresh rotativo, TURN com credenciais temporárias.

**Fase 5 — Espelhamento**: captura de tela real (WGC/DXGI no Windows; X11 no Linux), WebRTC com
H.264 preferido (hardware), troca de monitor, cursor incluído no vídeo.

**Fase 6 — Visualização**: modo Tela completa (sem distorção, sem margens desnecessárias), modo
Resolução original (1 px PC = 1 px físico), zoom por pinça, movimentação, tela cheia imersiva,
retrato/paisagem, barra discreta que se oculta, ajuste automático de resolução.

**Fase 7 — Mouse e Touch**: modo Touch (toque direto) e modo Mouse (touchpad com aceleração, cursor
local, botões L/M/R); clique, duplo clique, clique direito, arrastar e soltar, rolagem vertical e
horizontal, mouse físico/Bluetooth.

**Fase 8 — Teclado**: teclado nativo do Android com digitação em tempo real, acentos e símbolos
(Unicode), autocorreção tratada por diferença de texto, barra de teclas especiais (Esc, Tab,
Ctrl, Alt, Shift, Win, Del, Enter, ⌫, setas, F1–F12, Home/End/PgUp/PgDn/Ins/PrtSc), modificadores
fixáveis, 26 atalhos, abertura automática ao tocar em campo de texto (Windows, via caret),
teclado físico/Bluetooth.

**Fase 9 — Áudio e gravação**: som do PC (loopback do Windows) com liga/desliga, volume e qualidade
(32/64/128 kbps Opus); microfone do celular → alto-falantes do PC; gravação no PC (MP4/WebM, com
pausa, qualidade, áudio mixado) e no celular (Filmes/RemoteX); indicadores REC nos dois lados;
exige permissão concedida pelo PC.

**Fase 10 — Administração**: aprovação/recusa, dispositivos autorizados com permissões individuais,
revogação, histórico local e no servidor, encerrar sessão, senha de acesso, acesso não assistido,
política global de funções, painel administrativo remoto no celular (RPC), gestão de usuários
(administrador do servidor), auditoria, solicitação de modo administrador via UAC oficial.

**Fase 11 — Segurança, testes e otimizações**: ver [SEGURANCA.md](SEGURANCA.md) e [TESTES.md](TESTES.md);
qualidade adaptativa (bitrate/FPS/resolução).

**Fase 12 — Distribuição**: instalador NSIS, APK assinado, imagem Docker/Compose, pipeline de CI.

## Métricas medidas (teste ponta a ponta, rede local)

| Métrica | Resultado |
|---|---|
| Resolução recebida | 1280×800 (nativa do monitor de teste) |
| Latência de entrada (toque → evento no PC) | 8–25 ms |
| Latência ida-e-volta (toque → PC → imagem atualizada no celular) | mediana 65–90 ms (mín. 45, máx. ~110) |
| Precisão do clique | ±1 px (inclusive com zoom) |
| Gravação de 3,5 s no PC | MP4 de ~510 KB |

## Erros encontrados durante o desenvolvimento (e corrigidos)

1. **Rastreador de estatísticas** usava timestamp 0 como sentinela → taxa sempre 0 na 1ª amostra. Corrigido (`null`).
2. **Limite de taxa contornável**: IDs com dígito verificador inválido retornavam antes do limitador. Agora toda tentativa conta.
3. **Electron 44 mudou `clipboard` para API assíncrona** (Promise). Host adaptado.
4. **Injetor X11**: o mapa de teclado vinha como `BigUint64Array` (koffi 3), quebrando comparações; caracteres fora do layout trocavam entre si por reuso do mesmo keycode. Corrigido com conversão, rodízio de keycodes e pré-mapeamento dos acentos do português.
5. **Janela de aprovação** perdia permissões marcadas em sequência (cópia original reutilizada).
6. **Folha (sheet) em animação de fechamento** interceptava toques na tela remota.
7. **Atualização de presença recriava a tela inicial** e apagava o ID sendo digitado.
8. **Folha de gravação** permanecia aberta após "Parar e salvar", cobrindo a barra.
9. **`configChanges=density`** e APIs >23 (setters, `shouldOverrideUrlLoading` com request, `java.time`) incompatíveis com o build Android alternativo; ajustados.
10. **Kotlin stdlib usa `invokedynamic`** → mínimo real é Android 8.0 (API 26); manifesto corrigido para não declarar suporte inexistente.
11. **Host sem log em Windows** (apps GUI não têm console) → adicionado log rotativo em arquivo; requisições HTTP ganharam timeout.

## Limitações técnicas (honestas)

- **Validação em Windows físico pendente**: o host foi validado em Linux (Xvfb) com o mesmo código
  (Chromium/WebRTC/IPC/autorização), e o caminho Windows teve o layout binário do `SendInput`
  verificado e as bibliotecas FFI carregadas no `.exe` real sob Wine. Sob Wine a criação de janelas
  do Electron trava (limitação do Wine). O CI tem um job `windows-latest` que executa `SendInput`/
  `GetCursorPos` em Windows real e gera o instalador; **o primeiro run ficou na fila sem iniciar
  jobs** — verifique se o GitHub Actions está habilitado/com minutos na conta.
- **App Android não testado em aparelho físico/emulador** neste ambiente (o SDK/emulador do Google
  não estava acessível). O núcleo foi testado em Chromium com emulação de toque; o APK foi
  compilado, assinado e verificado.
- **Ctrl+Alt+Del** não pode ser gerado por programas comuns (exige serviço do sistema + política
  `SoftwareSASGeneration`). Alternativas: Gerenciador de Tarefas e Bloquear computador.
- **UIPI**: sem elevação, o Windows bloqueia entrada em janelas de processos administrativos; o
  RemoteX detecta e avisa. A tela do UAC (Área de Trabalho Segura) não pode ser capturada.
- **Tela de login/bloqueio do Windows** não é acessível (exigiria um serviço SYSTEM, fora do escopo
  desta versão).
- **Áudio do sistema** é capturado só no Windows. Com microfone e som ativos ao mesmo tempo, o
  celular pode ouvir o eco da própria voz (o loopback captura tudo o que o PC reproduz).
- **Abertura automática do teclado** depende de o programa expor o cursor de texto (caret) ao
  Windows — funciona em Win32 clássicos; navegadores e apps modernos podem não informar.
- **Gravação no celular** usa MediaRecorder do WebView (WebM/MP4 conforme o aparelho).
- **Escala horizontal** do servidor exige Redis para presença/limitadores (não implementado).
- **SmartScreen**: sem certificado de assinatura de código o Windows avisa ao instalar.

## Próximas etapas recomendadas

1. Executar em **Windows 10/11 físico** e em **celulares Android reais** (roteiro em [TESTES.md](TESTES.md)).
2. Ativar o GitHub Actions e acompanhar o job `windows-latest`.
3. Serviço Windows (SYSTEM) opcional para tela de login, UAC e Ctrl+Alt+Del (`SendSAS`).
4. Transferência de arquivos PC ↔ celular pelo canal de dados.
5. Atualização automática (electron-updater) com instalador assinado.
6. Cancelamento de eco para microfone + áudio simultâneos; Redis para múltiplas instâncias.
7. Publicação na Play Store (build Gradle, keystore de release) e versão iOS do cliente.
