# Protocolos do RemoteX

Definições em TypeScript: `signaling-server/protocol.ts` e `media-engine/channel-protocol.ts`.
Versão do protocolo: `PROTOCOL_VERSION = 1` (`shared/version.ts`).

## 1. API REST (`/api`)

Autenticação: dispositivos usam `Authorization: Device <id>:<token>`; contas usam
`Authorization: Bearer <JWT>`.

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| GET | `/api/health` | — | Saúde do servidor e do banco |
| POST | `/api/devices/register` | opcional (conta) | Registra PC (`host`) ou celular (`client`) → `{deviceId, token}` |
| GET/PATCH | `/api/devices/me` | dispositivo | Dados do próprio dispositivo / renomear / chave pública |
| GET | `/api/devices/status?ids=` | — | Online/offline de até 50 IDs |
| GET | `/api/ice-servers` | dispositivo | STUN/TURN com credenciais temporárias |
| GET | `/api/devices/me/sessions` | dispositivo | Histórico de sessões do dispositivo |
| POST | `/api/auth/register` · `/login` · `/refresh` · `/logout` | — | Contas (o primeiro usuário vira administrador) |
| GET | `/api/me` | conta | Usuário atual |
| POST | `/api/devices/claim` | conta | Vincula um dispositivo à conta |
| GET | `/api/devices` | conta | Dispositivos da conta com status online |
| PATCH/DELETE | `/api/devices/:id` | conta (dono) | Renomear / revogar (derruba a conexão) |
| GET | `/api/sessions` | conta | Sessões dos dispositivos da conta |
| GET/PATCH | `/api/admin/users[/:id]` | admin | Listar, ativar/desativar, promover usuários |
| GET | `/api/admin/audit` · `/api/admin/stats` | admin | Auditoria e estatísticas |

Erros: `{ "error": "CODIGO", "message": "texto em português" }`. Limites: 600 req/min por IP,
30 registros/h por IP, login com bloqueio exponencial por conta.

## 2. Sinalização (WebSocket `/ws`, JSON)

Celular/PC → servidor:

| `t` | Campos | Descrição |
|---|---|---|
| `hello` | `deviceId, token, kind, name, platform, version, protocol` | Primeira mensagem (até 10 s) |
| `connect` | `reqId, hostId, clientNonce` | Pedido de acesso a um PC |
| `relay` | `sessionId, payload` | Mensagem ponta a ponta para o outro participante |
| `session.state` | `sessionId, state, authMethod, reason` | (PC) `authorizing`/`authorized`/`rejected`/`active` |
| `session.end` | `sessionId, reason` | Encerrar |
| `presence.query` | `ids[]` | Status de até 50 IDs |
| `ping` | — | — |

Servidor → dispositivos: `hello.ok`, `error{code,message,reqId?}`, `session.created` (celular),
`session.incoming` (PC, com `clientNonce` e dados do celular), `relay`, `session.ended`, `presence`, `pong`.

Códigos de erro: `UNAUTHORIZED`, `REVOKED`, `HOST_NOT_FOUND`, `HOST_OFFLINE`, `RATE_LIMITED`,
`SESSION_NOT_FOUND`, `SELF_CONNECT`, `BAD_REQUEST`, `INTERNAL`.

### Mensagens ponta a ponta (`relay.payload.k`)

| `k` | Direção | Conteúdo |
|---|---|---|
| `auth.hello` | PC → celular | métodos, nome, chave pública Ed25519 do PC, `hostNonce`, assinatura de `remotex-host-v1\|sessão\|hostId\|clientNonce\|hostNonce`, sal/parâmetros scrypt |
| `auth.password` | celular → PC | `proof = HMAC(K, remotex-auth-v1\|sessão\|hostId\|clientId\|hostNonce\|clientNonce)` + assinatura do celular |
| `auth.device` | celular → PC | assinatura Ed25519 de `remotex-client-v1\|…` |
| `auth.approval` | celular → PC | pedido de aprovação (assinado) |
| `auth.pending` / `auth.result` | PC → celular | aguardando / resultado com permissões ou código (`BAD_PASSWORD`, `LOCKED`, `REJECTED`, `TIMEOUT`, `DISABLED`, `BUSY`…) |
| `sdp` / `ice` | ambos | Oferta (PC), resposta (celular), candidatos ICE |
| `bye` | ambos | Encerramento |

## 3. Canais de dados WebRTC

- `control` — confiável e ordenado.
- `motion` — ordenado, sem retransmissão (`maxRetransmits: 0`): movimentos e posição do cursor.

Coordenadas são normalizadas (0..1) em relação ao monitor capturado. Cada clique/botão carrega a
posição e um número de sequência `s`; movimentos com `s` menor que o do último botão são descartados.

Celular → PC: `hello`, `bind{proof}`, `key{code,down}`, `combo{codes[]}`, `text{text}`,
`btn{b,down,x,y,s}`, `click{b,x,y,n,s}`, `wheel{dx,dy,x,y}` (120 = 1 clique), `release`,
`quality{preset,original}`, `audio{enabled,quality}`, `mic{enabled}`, `clip{text}`, `clip.get`,
`rec{action,target,quality,audio}`, `display{id}`, `special{action}`, `rpc{id,method,params}`,
`cstats{…}`, `bye`. Em `motion`: `mv{x,y,s}`.

PC → celular: `welcome{hostName,os,permissions,displays,activeDisplay,sas,hostBind,…}`,
`bind.result`, `perms`, `clip`, `ime{editable}`, `rec.state`, `notice{level,message,code}`,
`quality.state`, `display`, `audio.state`, `rpc.res`, `bye`. Em `motion`: `cur{x,y}`.

Teclas usam os nomes de `KeyboardEvent.code` (`KeyA`, `Enter`, `F5`, `ControlLeft`…), mapeados para
VK do Windows/keysyms X11 em `remote-input/keymap.ts`. Texto livre vai como Unicode
(`KEYEVENTF_UNICODE`) e independe do layout do teclado do PC.

### RPC de administração (`rpc.method`)

`admin.overview`, `admin.listTrusted`, `admin.updateTrusted{deviceId,permissions?,unattended?,name?}`,
`admin.revokeTrusted{deviceId}`, `admin.history{limit}`, `admin.setIncoming{enabled}`,
`admin.setAttended{enabled}`, `admin.setUnattended{enabled}`, `admin.setPolicy{policy}`,
`admin.listRecordings`, `system.requestElevation`. Exigem a permissão `admin`.
