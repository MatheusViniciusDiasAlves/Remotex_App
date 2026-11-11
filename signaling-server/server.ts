/**
 * Servidor de sinalização RemoteX (WebSocket).
 *
 * Responsabilidades:
 *  - autenticar dispositivos (ID + token) e manter presença online/offline;
 *  - intermediar pedidos de conexão por ID (celular → computador);
 *  - retransmitir mensagens ponta a ponta (autenticação, SDP, ICE) só entre os dois
 *    participantes de uma sessão;
 *  - aplicar limites de taxa (anti força bruta / abuso) e registrar histórico e auditoria.
 *
 * O servidor NÃO participa da autenticação do acesso ao computador (senha/aprovação/chave do
 * dispositivo são verificadas pelo próprio computador) e nunca vê a tela, o áudio ou o teclado:
 * a mídia trafega por WebRTC (DTLS-SRTP) direto entre os aparelhos ou via TURN.
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { SlidingWindowLimiter } from '@remotex/security/rate-limiter';
import { isValidDeviceId } from '@remotex/shared/ids';
import { uuid } from '@remotex/shared/ids';
import { PROTOCOL_VERSION } from '@remotex/shared/version';
import {
  MAX_SIGNAL_MESSAGE_BYTES,
  type AuthMethod,
  type ClientToServer,
  type DeviceKind,
  type ErrorCode,
  type IceServer,
  type ServerToClient,
  type SessionState,
} from './protocol';

export interface SignalingDevice {
  id: string;
  kind: DeviceKind;
  name: string;
  platform: string;
  ownerEmail?: string | null;
}

export interface SignalingDeps {
  authenticateDevice(id: string, token: string): Promise<SignalingDevice | 'revoked' | null>;
  getDevice(id: string): Promise<(SignalingDevice & { revoked?: boolean }) | null>;
  touchDevice(id: string, ip: string | null): Promise<void>;
  createSession(s: { id: string; hostId: string; clientId: string; clientIp: string | null }): Promise<void>;
  updateSession(
    id: string,
    patch: { status?: string; authMethod?: string | null; started?: boolean; ended?: boolean; endReason?: string | null },
  ): Promise<void>;
  audit(e: { actorType: string; actorId: string | null; action: string; target?: string | null; ip?: string | null; details?: unknown }): Promise<void>;
  iceServers(deviceId: string): IceServer[];
}

export interface SignalingOptions {
  path?: string;
  trustProxy?: boolean;
  helloTimeoutMs?: number;
  pendingTimeoutMs?: number;
  heartbeatMs?: number;
  maxPendingPerHost?: number;
}

interface Conn {
  ws: WebSocket;
  ip: string | null;
  device: SignalingDevice | null;
  alive: boolean;
  sessions: Set<string>;
  relayLimiter: SlidingWindowLimiter;
  helloTimer: NodeJS.Timeout | null;
}

interface Session {
  id: string;
  hostId: string;
  clientId: string;
  state: SessionState | 'pending';
  createdAt: number;
  authMethod?: AuthMethod;
  timer: NodeJS.Timeout | null;
}

export class SignalingServer {
  private wss: WebSocketServer | null = null;
  private online = new Map<string, Conn>();
  private sessions = new Map<string, Session>();
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly opts: Required<SignalingOptions>;

  // Limites: tentativas de conexão por celular, por IP e por computador de destino.
  private connectByClient = new SlidingWindowLimiter(10, 60_000);
  private connectByIp = new SlidingWindowLimiter(30, 60_000);
  private connectByHost = new SlidingWindowLimiter(30, 60_000);
  private helloByIp = new SlidingWindowLimiter(60, 60_000);
  private helloFailByIp = new SlidingWindowLimiter(10, 10 * 60_000);

  constructor(
    private readonly deps: SignalingDeps,
    opts: SignalingOptions = {},
  ) {
    this.opts = {
      path: opts.path ?? '/ws',
      trustProxy: opts.trustProxy ?? false,
      helloTimeoutMs: opts.helloTimeoutMs ?? 10_000,
      pendingTimeoutMs: opts.pendingTimeoutMs ?? 120_000,
      heartbeatMs: opts.heartbeatMs ?? 25_000,
      maxPendingPerHost: opts.maxPendingPerHost ?? 4,
    };
  }

  attach(server: HttpServer): void {
    this.wss = new WebSocketServer({ server, path: this.opts.path, maxPayload: MAX_SIGNAL_MESSAGE_BYTES });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    this.heartbeat = setInterval(() => this.sweep(), this.opts.heartbeatMs);
  }

  isOnline(id: string): boolean {
    return this.online.has(id);
  }

  onlineMap(ids: string[]): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const id of ids) out[id] = this.online.has(id);
    return out;
  }

  stats() {
    let hosts = 0;
    let clients = 0;
    for (const c of this.online.values()) c.device?.kind === 'host' ? hosts++ : clients++;
    return { hostsOnline: hosts, clientsOnline: clients, sessions: this.sessions.size };
  }

  /** Derruba a conexão de um dispositivo (ex.: revogado pelo dono). */
  disconnectDevice(id: string, reason = 'revoked'): void {
    const c = this.online.get(id);
    if (!c) return;
    this.send(c, { t: 'error', code: 'REVOKED', message: 'Dispositivo revogado' });
    c.ws.close(4003, reason);
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.online.values()) c.ws.close(1001, 'server-shutdown');
    for (const s of this.sessions.values()) if (s.timer) clearTimeout(s.timer);
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
  }

  // ------------------------------------------------------------------------------------------

  private clientIp(req: IncomingMessage): string | null {
    if (this.opts.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? null;
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const ip = this.clientIp(req);
    const conn: Conn = {
      ws,
      ip,
      device: null,
      alive: true,
      sessions: new Set(),
      relayLimiter: new SlidingWindowLimiter(400, 10_000),
      helloTimer: null,
    };
    if (!this.helloByIp.hit(ip || '?')) {
      ws.close(4029, 'rate-limited');
      return;
    }
    conn.helloTimer = setTimeout(() => ws.close(4008, 'hello-timeout'), this.opts.helloTimeoutMs);
    ws.on('pong', () => (conn.alive = true));
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return this.error(conn, 'BAD_REQUEST', 'Mensagens binárias não são aceitas');
      let msg: ClientToServer;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return this.error(conn, 'BAD_REQUEST', 'JSON inválido');
      }
      this.onMessage(conn, msg).catch((err) => {
        console.error('[signaling] erro ao processar mensagem', err);
        this.error(conn, 'INTERNAL', 'Erro interno');
      });
    });
    ws.on('close', () => this.onClose(conn));
    ws.on('error', () => undefined);
  }

  private async onMessage(conn: Conn, msg: ClientToServer): Promise<void> {
    if (!msg || typeof msg !== 'object' || typeof (msg as any).t !== 'string') {
      return this.error(conn, 'BAD_REQUEST', 'Mensagem inválida');
    }
    if (!conn.device) {
      if (msg.t !== 'hello') return this.error(conn, 'UNAUTHORIZED', 'Envie hello primeiro');
      return this.onHello(conn, msg);
    }
    switch (msg.t) {
      case 'connect':
        return this.onConnect(conn, msg);
      case 'relay':
        return this.onRelay(conn, msg);
      case 'session.state':
        return this.onSessionState(conn, msg);
      case 'session.end':
        return this.endSession(msg.sessionId, typeof msg.reason === 'string' ? msg.reason.slice(0, 80) : 'ended', conn.device.id);
      case 'presence.query': {
        const ids = Array.isArray(msg.ids) ? msg.ids.filter((x) => typeof x === 'string' && isValidDeviceId(x)).slice(0, 50) : [];
        return this.send(conn, { t: 'presence', statuses: this.onlineMap(ids) });
      }
      case 'ping':
        return this.send(conn, { t: 'pong', serverTime: Date.now() });
      case 'hello':
        return this.error(conn, 'BAD_REQUEST', 'Já autenticado');
      default:
        return this.error(conn, 'BAD_REQUEST', 'Tipo de mensagem desconhecido');
    }
  }

  private async onHello(conn: Conn, msg: Extract<ClientToServer, { t: 'hello' }>): Promise<void> {
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.error(conn, 'BAD_REQUEST', `Versão de protocolo incompatível (servidor: ${PROTOCOL_VERSION})`);
      conn.ws.close(4000, 'protocol');
      return;
    }
    if (!this.helloFailByIp.remaining(conn.ip || '?')) {
      this.error(conn, 'RATE_LIMITED', 'Muitas falhas de autenticação. Aguarde.');
      conn.ws.close(4029, 'rate-limited');
      return;
    }
    const dev = await this.deps.authenticateDevice(String(msg.deviceId || ''), String(msg.token || ''));
    if (!dev || dev === 'revoked' || dev.kind !== msg.kind) {
      this.helloFailByIp.hit(conn.ip || '?');
      await this.deps.audit({ actorType: 'device', actorId: String(msg.deviceId || '').slice(0, 12), action: 'signaling.auth_failed', ip: conn.ip, details: { revoked: dev === 'revoked' } });
      this.error(conn, dev === 'revoked' ? 'REVOKED' : 'UNAUTHORIZED', dev === 'revoked' ? 'Dispositivo revogado' : 'Credenciais do dispositivo inválidas');
      conn.ws.close(4001, 'unauthorized');
      return;
    }
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    const previous = this.online.get(dev.id);
    if (previous && previous !== conn) {
      previous.ws.close(4002, 'replaced');
      this.onClose(previous);
    }
    conn.device = dev;
    this.online.set(dev.id, conn);
    await this.deps.touchDevice(dev.id, conn.ip);
    this.send(conn, { t: 'hello.ok', deviceId: dev.id, serverTime: Date.now(), name: dev.name });
  }

  private async onConnect(conn: Conn, msg: Extract<ClientToServer, { t: 'connect' }>): Promise<void> {
    const client = conn.device!;
    const reqId = typeof msg.reqId === 'string' ? msg.reqId.slice(0, 64) : '';
    const hostId = String(msg.hostId || '').replace(/\D/g, '');
    const clientNonce = typeof msg.clientNonce === 'string' && /^[0-9a-f]{32,64}$/.test(msg.clientNonce) ? msg.clientNonce : null;
    // Toda tentativa conta para o limite — inclusive IDs inválidos (impede varredura de IDs).
    if (!this.connectByClient.hit(client.id) || !this.connectByIp.hit(conn.ip || '?') || !this.connectByHost.hit(hostId || '?')) {
      await this.deps.audit({ actorType: 'device', actorId: client.id, action: 'session.rate_limited', target: hostId.slice(0, 12), ip: conn.ip });
      return this.error(conn, 'RATE_LIMITED', 'Muitas tentativas de conexão. Aguarde um minuto.', reqId);
    }
    if (!clientNonce) return this.error(conn, 'BAD_REQUEST', 'clientNonce inválido', reqId);
    if (!isValidDeviceId(hostId)) return this.error(conn, 'HOST_NOT_FOUND', 'ID inválido. Confira os 9 dígitos.', reqId);
    if (hostId === client.id) return this.error(conn, 'SELF_CONNECT', 'Não é possível conectar ao próprio dispositivo', reqId);
    const host = await this.deps.getDevice(hostId);
    if (!host || host.kind !== 'host' || host.revoked) return this.error(conn, 'HOST_NOT_FOUND', 'Computador não encontrado', reqId);
    const hostConn = this.online.get(hostId);
    if (!hostConn || !hostConn.device) return this.error(conn, 'HOST_OFFLINE', 'O computador está offline', reqId);
    const pending = [...hostConn.sessions].filter((id) => this.sessions.get(id)?.state !== 'active').length;
    if (pending >= this.opts.maxPendingPerHost) return this.error(conn, 'RATE_LIMITED', 'O computador está ocupado com outras solicitações', reqId);

    const session: Session = { id: uuid(), hostId, clientId: client.id, state: 'pending', createdAt: Date.now(), timer: null };
    session.timer = setTimeout(() => {
      const s = this.sessions.get(session.id);
      if (s && s.state !== 'active') this.endSession(s.id, 'timeout', null);
    }, this.opts.pendingTimeoutMs);
    this.sessions.set(session.id, session);
    conn.sessions.add(session.id);
    hostConn.sessions.add(session.id);
    await this.deps.createSession({ id: session.id, hostId, clientId: client.id, clientIp: conn.ip });
    await this.deps.audit({ actorType: 'device', actorId: client.id, action: 'session.requested', target: hostId, ip: conn.ip, details: { sessionId: session.id } });

    this.send(conn, {
      t: 'session.created',
      reqId,
      sessionId: session.id,
      host: { id: host.id, name: host.name, platform: host.platform },
      iceServers: this.deps.iceServers(client.id),
    });
    this.send(hostConn, {
      t: 'session.incoming',
      sessionId: session.id,
      client: { id: client.id, name: client.name, platform: client.platform, ip: conn.ip ?? undefined, account: client.ownerEmail ?? null },
      clientNonce,
      iceServers: this.deps.iceServers(hostId),
    });
  }

  private onRelay(conn: Conn, msg: Extract<ClientToServer, { t: 'relay' }>): void {
    const s = this.sessions.get(String(msg.sessionId));
    const me = conn.device!.id;
    if (!s || (s.hostId !== me && s.clientId !== me)) return this.error(conn, 'SESSION_NOT_FOUND', 'Sessão inexistente', undefined, String(msg.sessionId));
    if (!conn.relayLimiter.hit('relay')) return this.error(conn, 'RATE_LIMITED', 'Mensagens demais', undefined, s.id);
    if (!msg.payload || typeof msg.payload !== 'object' || typeof (msg.payload as any).k !== 'string') {
      return this.error(conn, 'BAD_REQUEST', 'payload inválido', undefined, s.id);
    }
    const otherId = s.hostId === me ? s.clientId : s.hostId;
    const other = this.online.get(otherId);
    if (!other) {
      this.endSession(s.id, 'peer-offline', null);
      return;
    }
    this.send(other, { t: 'relay', sessionId: s.id, payload: msg.payload });
  }

  private async onSessionState(conn: Conn, msg: Extract<ClientToServer, { t: 'session.state' }>): Promise<void> {
    const s = this.sessions.get(String(msg.sessionId));
    if (!s || s.hostId !== conn.device!.id) return this.error(conn, 'SESSION_NOT_FOUND', 'Sessão inexistente');
    const allowed: SessionState[] = ['authorizing', 'authorized', 'rejected', 'active'];
    if (!allowed.includes(msg.state)) return this.error(conn, 'BAD_REQUEST', 'Estado inválido');
    const method = (['password', 'device', 'approval'] as const).find((m) => m === msg.authMethod);
    s.state = msg.state;
    if (method) s.authMethod = method;
    await this.deps.updateSession(s.id, { status: msg.state, authMethod: method ?? null, started: msg.state === 'active' });
    if (msg.state === 'active' && s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    if (msg.state === 'authorized' || msg.state === 'rejected') {
      await this.deps.audit({
        actorType: 'device',
        actorId: s.hostId,
        action: msg.state === 'authorized' ? 'session.authorized' : 'session.rejected',
        target: s.clientId,
        details: { sessionId: s.id, method, reason: typeof msg.reason === 'string' ? msg.reason.slice(0, 80) : undefined },
      });
    }
  }

  private endSession(sessionId: string, reason: string, byDevice: string | null): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (byDevice && s.hostId !== byDevice && s.clientId !== byDevice) return;
    if (s.timer) clearTimeout(s.timer);
    this.sessions.delete(sessionId);
    for (const id of [s.hostId, s.clientId]) {
      const c = this.online.get(id);
      if (!c) continue;
      c.sessions.delete(sessionId);
      if (id !== byDevice) this.send(c, { t: 'session.ended', sessionId, reason });
    }
    const status = s.state === 'rejected' ? 'rejected' : 'ended';
    this.deps.updateSession(sessionId, { status, ended: true, endReason: reason }).catch(() => undefined);
  }

  private onClose(conn: Conn): void {
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    if (conn.device && this.online.get(conn.device.id) === conn) {
      this.online.delete(conn.device.id);
      this.deps.touchDevice(conn.device.id, null).catch(() => undefined);
    }
    for (const sid of [...conn.sessions]) this.endSession(sid, 'peer-disconnected', conn.device?.id ?? null);
    conn.sessions.clear();
  }

  private sweep(): void {
    for (const c of this.online.values()) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        /* conexão já fechada */
      }
    }
    this.connectByClient.sweep();
    this.connectByIp.sweep();
    this.connectByHost.sweep();
    this.helloByIp.sweep();
  }

  private send(conn: Conn, msg: ServerToClient): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  private error(conn: Conn, code: ErrorCode, message: string, reqId?: string, sessionId?: string): void {
    this.send(conn, { t: 'error', code, message, reqId, sessionId });
  }
}
