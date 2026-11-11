# Manual do usuário — RemoteX

## No computador (RemoteX Host)

1. Instale `RemoteX-Host-Setup.exe` e abra o **RemoteX Host**.
2. Em **Início** aparece o **ID RemoteX** (9 dígitos, ex.: `482 913 557`) e o status **Online**.
3. Por padrão, cada pedido de acesso abre uma janela de **aprovação**: confira o nome e a impressão
   digital do celular, escolha as permissões e clique em **Aceitar** ou **Recusar**.
   - *Confiar neste dispositivo* + *Permitir acesso não assistido*: nas próximas vezes esse celular
     conecta sem confirmação.
4. Para acessar sem ninguém no PC: **Segurança e acesso → Acesso não assistido** + defina uma
   **senha de acesso**.
5. Durante uma sessão, um **banner vermelho** no topo da tela mostra quem está conectado, há quanto
   tempo e o código de verificação. Clique em **Encerrar** a qualquer momento.
6. **Desativar conexões remotas** (Início ou ícone da bandeja) bloqueia todos os pedidos.

| Página | Para quê |
|---|---|
| Segurança e acesso | Aprovação manual, acesso não assistido, senha, permissões por senha, funções permitidas |
| Dispositivos confiáveis | Permissões por aparelho, acesso não assistido, revogar |
| Histórico | Quem conectou, quando, de onde, método e resultado |
| Gravações | Arquivos gravados no PC, pasta e qualidade |
| Configurações | Nome, servidor, qualidade de vídeo/codec, áudio, iniciar com o Windows, segundo plano |

**Iniciar com o Windows** e **continuar em segundo plano** são desligados por padrão; quando ligados,
o ícone na bandeja indica que o acesso remoto está disponível.

**Programas executados como administrador** (Gerenciador de Tarefas, instaladores): o Windows impede
que programas comuns os controlem. Use **Reiniciar como administrador** (no PC) ou **Admin → Solicitar
modo administrador** (no celular); o Windows pedirá confirmação (UAC) na tela do computador.

## No celular (app RemoteX)

1. Instale o APK e abra o app. Em **Ajustes → Servidor**, confirme o endereço do servidor.
2. Em **Início**, digite o ID do computador e toque em **Conectar**.
3. Conforme o computador: aguarde a aprovação, digite a senha (marque *Lembrar neste celular* se
   quiser) ou conecte direto (dispositivo confiável).
4. A tela do PC aparece. Toque em **⋯** (canto superior direito) para abrir a barra de ferramentas.

### Gestos

| Gesto | Modo Touch | Modo Mouse (touchpad) |
|---|---|---|
| Toque | Clique no ponto tocado | Clique onde está o cursor |
| Toque duplo | Duplo clique | Duplo clique |
| Toque longo | Clique direito | Ao soltar: clique direito |
| Arrastar 1 dedo | Arrastar/selecionar (botão pressionado) | Mover o cursor |
| Tocar e arrastar / longo e arrastar | — | Arrastar com botão pressionado |
| Toque com 2 dedos | Clique direito | Clique direito |
| Deslizar 2 dedos | Rolagem vertical/horizontal | Rolagem |
| Pinça | Zoom | Zoom (a imagem segue o cursor) |
| Arrastar 3 dedos | Mover a imagem ampliada | Mover a imagem ampliada |

No modo Mouse há botões **Esquerdo / Meio / Direito** na parte inferior (segure para arrastar).

### Barra de ferramentas

**Teclado** · **Touch/Mouse** · **Tela completa ↔ Original** (1 pixel do PC = 1 pixel do celular) ·
**Tela cheia** · **Qualidade** (Automática, Alta, Equilibrada, Econômica) · **Áudio** (som do PC,
volume, qualidade, microfone) · **Gravar** · **Atalhos** · **Copiar/colar** · **Monitores** ·
**Admin** · **Ajustes** · **Desconectar**.

### Teclado

Usa o teclado do próprio Android: acentos, ç, símbolos e emojis chegam ao PC exatamente como
digitados, independentemente do layout do teclado do computador. A barra acima do teclado tem
**Esc, Tab, Ctrl, Alt, Shift, Win, Del, ⌫, Enter, setas, Home, End, PgUp, PgDn, Ins, PrtSc, Fn
(F1–F12)** e **Atalhos**. Ctrl/Alt/Shift/Win: um toque vale para a próxima tecla; dois toques
travam.

Quando você toca em um campo de texto no Windows, o teclado abre sozinho (se o programa informar o
cursor de texto ao Windows — ajuste em Ajustes).

### Atalhos prontos

Copiar, Colar, Recortar, Desfazer, Refazer, Selecionar tudo, Salvar, Localizar, Alt+Tab, Alt+F4,
Iniciar, Área de trabalho, Explorador, Executar, Maximizar/Minimizar/encaixar janelas, Visão de
tarefas, abas, Atualizar, Captura de tela, Gerenciador de Tarefas e Bloquear computador.
*Ctrl+Alt+Del* não pode ser simulado por programas (proteção do Windows) — o app explica e oferece
as alternativas.

### Gravação

**Gravar → Salvar no celular** (pasta Filmes/RemoteX) ou **Salvar no computador** (Vídeos\RemoteX).
Exige a permissão "Gravar a sessão" concedida pelo computador; durante a gravação aparece **● REC**
no celular e no banner do PC.

### Indicador de conexão

O chip no canto superior esquerdo mostra barras de qualidade e a latência; "TURN" indica conexão
via servidor de retransmissão. Toque nele para ver resolução, FPS, codec, perda e taxa.

### Código de verificação

Ao conectar, o app mostra um código de 6 dígitos que também aparece no banner do PC. Se forem
diferentes, desconecte: a conexão pode estar sendo interceptada.
