# Segurança do RemoteX

Princípio: **ninguém acessa o computador sem autorização do dono** — nem terceiros, nem o próprio
servidor RemoteX. O servidor apenas apresenta os aparelhos; a decisão de acesso acontece no PC.

## Ameaças consideradas e defesas

| Ameaça | Defesa |
|---|---|
| Alguém descobre o ID do PC | ID sozinho não dá acesso: exige aprovação, senha ou dispositivo confiável |
| Força bruta de senha | 3 tentativas por sessão; bloqueio exponencial global no PC após 5 falhas (1→2→4… até 60 min); limite de pedidos no servidor por celular (10/min), IP (30/min) e PC de destino (30/min), inclusive para IDs inválidos |
| Varredura de IDs | Limitadores de taxa + dígito verificador (Luhn) + auditoria de tentativas |
| Servidor de sinalização malicioso/comprometido (MITM) | Chave Ed25519 do PC fixada no celular (alerta se mudar); amarração das impressões DTLS por HMAC (senha) ou assinatura (dispositivo); código de verificação visível nos dois lados |
| Roubo de senha em trânsito | A senha nunca trafega: desafio/resposta scrypt (N=2^15) + HMAC-SHA256 com nonces dos dois lados (anti-replay) |
| Exposição do IP do PC a desconhecidos | O PC só gera candidatos ICE depois de autorizar o celular |
| Interceptação de tela/teclado | WebRTC: DTLS 1.2+ e SRTP obrigatórios; TURN só repassa pacotes cifrados |
| Celular roubado | Revogação do dispositivo confiável no PC (local ou pelo painel admin) e na conta (servidor derruba a conexão e invalida o token) |
| Sessões invisíveis | Banner vermelho sempre visível no PC durante a sessão, ícone na bandeja, notificação, indicador "REC" durante gravação |
| Abuso de permissões | Permissão efetiva = política global do PC ∩ permissões do dispositivo; verificada no PC a cada evento |
| Teclas presas após queda | Todas as teclas e botões pressionados são liberados ao fim da sessão |
| Elevação de privilégios | Nenhum bypass de UAC. "Modo administrador" reinicia o host com `ShellExecuteW("runas")`, que exibe o consentimento oficial do Windows |
| Vazamento de segredos no disco | Token do dispositivo, chave privada e verificador da senha cifrados com DPAPI (`safeStorage`) no Windows |
| Roubo de sessão de conta | JWT de 15 min + refresh token rotativo; reuso de refresh token antigo revoga toda a família |

## Métodos de autorização

1. **Aprovação manual** — janela sempre no topo no PC mostrando nome do celular, ID, impressão
   digital da chave, IP e conta; quem está no PC escolhe as permissões e pode marcar "Confiar neste
   dispositivo" e "Permitir acesso não assistido". Expira em 60 s (configurável).
2. **Senha de acesso** (acesso não assistido) — exige ativar "Acesso não assistido". Regras mínimas:
   8+ caracteres e 2 classes. O PC guarda apenas `K = scrypt(senha, sal)`, cifrado com DPAPI.
   O celular pode "lembrar" a senha guardando apenas `K` (específico daquele PC).
3. **Dispositivo confiável** — o celular assina o desafio com sua chave Ed25519; o PC confere com a
   chave pública aprovada anteriormente. Não depende do servidor.

## Criptografia utilizada

| Uso | Algoritmo |
|---|---|
| Identidade de dispositivos | Ed25519 (@noble/curves, auditada) |
| Derivação da senha de acesso | scrypt N=2^15, r=8, p=1 (limites aceitos pelo celular: N ≤ 2^17) |
| Prova de senha e amarração | HMAC-SHA256 |
| Código de verificação | SHA-256 das impressões DTLS → 6 dígitos |
| Mídia e canais de dados | DTLS-SRTP / SCTP-over-DTLS (WebRTC) |
| Transporte web | TLS (HTTPS/WSS via Caddy + Let's Encrypt) |
| Senhas de conta | scrypt (Node), comparação em tempo constante |
| Tokens de dispositivo/refresh | 256 bits aleatórios; servidor guarda só SHA-256 |
| TURN | credenciais temporárias HMAC-SHA1 (padrão coturn) com expiração |

## Permissões

`Ver a tela` (sempre), `Controlar mouse`, `Usar teclado e atalhos`, `Área de transferência`,
`Ouvir o áudio`, `Enviar microfone`, `Gravar a sessão`, `Administração remota`.
Cada uma é aplicada no PC: um celular sem `keyboard` não consegue digitar mesmo que modifique o app.

## Logs e auditoria

- **Servidor** (`audit_log`): registros, logins (e falhas), pedidos de sessão, limites de taxa,
  autorizações/recusas, revogações, ações de administradores.
- **Computador**: histórico local (dispositivo, IP, método, resultado, duração, motivo) e log técnico
  em `%APPDATA%\RemoteX Host\logs\remotex-host.log` (sem senhas, tokens ou chaves).

## Atualizações seguras

O instalador gera `latest.yml` com SHA-512 do pacote. Para distribuição pública, **assine o
instalador com certificado Authenticode** (variáveis `CSC_LINK`/`CSC_KEY_PASSWORD` no
electron-builder) e o APK com sua chave de release (`RELEASE_KEYSTORE`). Ver [IMPLANTACAO.md](IMPLANTACAO.md).

## Limitações de segurança conhecidas

- Na **aprovação manual**, um servidor comprometido poderia se passar pelo celular no primeiro
  contato; a defesa é comparar o **código de verificação** e a impressão digital exibidos no PC e no
  celular. Nos métodos senha e dispositivo confiável isso é verificado automaticamente.
- A tela de consentimento do UAC aparece na Área de Trabalho Segura do Windows e **não é capturada**
  (proteção do próprio Windows): alguém no PC precisa aprová-la.
- Sem certificado de assinatura de código, o Windows SmartScreen exibirá aviso ao instalar.
