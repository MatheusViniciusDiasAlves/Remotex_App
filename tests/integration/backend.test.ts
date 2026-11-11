/**
 * Integração do servidor: PostgreSQL real + API HTTP + sinalização WebSocket.
 * Executar com: npm run test:integration (o script cria o banco de teste).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startServer, type RunningServer } from '../../backend/src/server';
import { loadConfig } from '../../backend/src/config';
import { turnCredentials } from '@remotex/security/turn-credentials';
import { createHmac } from 'node:crypto';
import { PROTOCOL_VERSION } from '@remotex/shared/version';

const hasDb = Boolean(process.env.DATABASE_URL);

class WsClient {
  ws: WebSocket;
  inbox: any[] = [];
  waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
  closed: { code: number } | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      const w = this.waiters.findIndex((x) => x.pred(m));
      if (w >= 0) this.waiters.splice(w, 1)[0].resolve(m);
      else this.inbox.push(m);
    });
    this.ws.on('close', (code) => (this.closed = { code }));
  }
  open() {
    return new Promise<void>((r, j) => {
      this.ws.once('open', () => r());
      this.ws.once('error', j);
    });
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  next(pred: (m: any) => boolean, timeout = 3000): Promise<any> {
    const i = this.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout esperando mensagem')), timeout);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  }
  waitClose(timeout = 3000) {
    return new Promise<number>((resolve, reject) => {
      if (this.closed) return resolve(this.closed.code);
      const t = setTimeout(() => reject(new Error('timeout esperando fechamento')), timeout);
      this.ws.once('close', (code) => (clearTimeout(t), resolve(code)));
    });
  }
}

describe.runIf(hasDb)('backend + sinalização', () => {
  let srv: RunningServer;
  let base: string;
  let wsUrl: string;
  const clients: WsClient[] = [];

  const api = async (method: string, p: string, body?: unknown, auth?: string) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const connectWs = async (deviceId: string, token: string, kind: 'host' | 'client') => {
    const c = new WsClient(wsUrl);
    clients.push(c);
    await c.open();
    c.send({ t: 'hello', deviceId, token, kind, protocol: PROTOCOL_VERSION });
    return c;
  };

  let host: { deviceId: string; token: string };
  let phone: { deviceId: string; token: string };

  beforeAll(async () => {
    const config = { ...loadConfig({ ...process.env, PORT: '0', HOST: '127.0.0.1', JWT_SECRET: 'x'.repeat(40), TURN_URLS: 'turn:turn.example.com:3478?transport=udp', TURN_SECRET: 's3cr3t', STUN_URLS: 'stun:stun.example.com:3478', PUBLIC_DIR: '' }) };
    srv = await startServer(config);
    base = srv.url;
    wsUrl = base.replace('http', 'ws') + '/ws';
  });

  afterAll(async () => {
    for (const c of clients) c.ws.close();
    await srv?.close();
  });

  it('health', async () => {
    const r = await api('GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('registra computador e celular com IDs de 9 dígitos', async () => {
    const h = await api('POST', '/api/devices/register', { kind: 'host', name: 'PC Escritório', platform: 'win32' });
    const p = await api('POST', '/api/devices/register', { kind: 'client', name: 'Celular', platform: 'android' });
    expect(h.status).toBe(201);
    expect(h.body.deviceId).toMatch(/^[1-9]\d{8}$/);
    expect(h.body.token).toMatch(/^[0-9a-f]{64}$/);
    host = { deviceId: h.body.deviceId, token: h.body.token };
    phone = { deviceId: p.body.deviceId, token: p.body.token };
    const bad = await api('POST', '/api/devices/register', { kind: 'servidor', name: '' });
    expect(bad.status).toBe(400);
  });

  it('API de dispositivo exige token correto e fornece credenciais TURN temporárias', async () => {
    expect((await api('GET', '/api/devices/me', undefined, `Device ${host.deviceId}:${'0'.repeat(64)}`)).status).toBe(401);
    const me = await api('GET', '/api/devices/me', undefined, `Device ${host.deviceId}:${host.token}`);
    expect(me.body.device.name).toBe('PC Escritório');
    const ice = await api('GET', '/api/ice-servers', undefined, `Device ${phone.deviceId}:${phone.token}`);
    const turn = ice.body.iceServers.find((s: any) => s.username);
    expect(turn.username).toMatch(new RegExp(`^\\d+:${phone.deviceId}$`));
    expect(turn.credential).toBe(createHmac('sha1', 's3cr3t').update(turn.username).digest('base64'));
    const c = turnCredentials('k', 'id', 60, 1000);
    expect(c.username).toBe('1060:id');
  });

  it('sinalização rejeita token inválido', async () => {
    const c = await connectWs(host.deviceId, 'f'.repeat(64), 'host');
    const err = await c.next((m) => m.t === 'error');
    expect(err.code).toBe('UNAUTHORIZED');
    expect(await c.waitClose()).toBe(4001);
  });

  it('fluxo completo: presença, pedido de conexão, relay ponta a ponta, estado e encerramento', async () => {
    const h = await connectWs(host.deviceId, host.token, 'host');
    expect((await h.next((m) => m.t === 'hello.ok')).deviceId).toBe(host.deviceId);
    const p = await connectWs(phone.deviceId, phone.token, 'client');
    await p.next((m) => m.t === 'hello.ok');

    p.send({ t: 'presence.query', ids: [host.deviceId, '123456789'] });
    const pres = await p.next((m) => m.t === 'presence');
    expect(pres.statuses[host.deviceId]).toBe(true);

    const status = await api('GET', `/api/devices/status?ids=${host.deviceId}`);
    expect(status.body.statuses[host.deviceId]).toBe(true);

    const nonce = 'a'.repeat(32);
    p.send({ t: 'connect', reqId: 'r1', hostId: host.deviceId.replace(/(\d{3})/g, '$1 '), clientNonce: nonce });
    const created = await p.next((m) => m.t === 'session.created');
    const incoming = await h.next((m) => m.t === 'session.incoming');
    expect(created.sessionId).toBe(incoming.sessionId);
    expect(created.host.name).toBe('PC Escritório');
    expect(incoming.client.id).toBe(phone.deviceId);
    expect(incoming.clientNonce).toBe(nonce);
    expect(incoming.iceServers.length).toBe(2);
    const sid = created.sessionId;

    h.send({ t: 'relay', sessionId: sid, payload: { k: 'auth.pending' } });
    expect((await p.next((m) => m.t === 'relay')).payload.k).toBe('auth.pending');
    p.send({ t: 'relay', sessionId: sid, payload: { k: 'sdp', type: 'answer', sdp: 'v=0' } });
    expect((await h.next((m) => m.t === 'relay')).payload.sdp).toBe('v=0');

    // um terceiro dispositivo não consegue injetar mensagens na sessão
    const intruderReg = await api('POST', '/api/devices/register', { kind: 'client', name: 'Intruso' });
    const intruder = await connectWs(intruderReg.body.deviceId, intruderReg.body.token, 'client');
    await intruder.next((m) => m.t === 'hello.ok');
    intruder.send({ t: 'relay', sessionId: sid, payload: { k: 'bye' } });
    expect((await intruder.next((m) => m.t === 'error')).code).toBe('SESSION_NOT_FOUND');

    h.send({ t: 'session.state', sessionId: sid, state: 'authorized', authMethod: 'password' });
    h.send({ t: 'session.state', sessionId: sid, state: 'active' });
    await new Promise((r) => setTimeout(r, 150));
    p.send({ t: 'session.end', sessionId: sid, reason: 'user' });
    expect((await h.next((m) => m.t === 'session.ended')).reason).toBe('user');
    await new Promise((r) => setTimeout(r, 150));

    const hist = await api('GET', '/api/devices/me/sessions', undefined, `Device ${host.deviceId}:${host.token}`);
    const row = hist.body.sessions.find((s: any) => s.id === sid);
    expect(row.status).toBe('ended');
    expect(row.authMethod).toBe('password');
    expect(row.startedAt).not.toBeNull();
    expect(row.endedAt).not.toBeNull();
    expect(row.clientName).toBe('Celular');
  });

  it('erros de conexão: offline, inexistente, próprio ID', async () => {
    const reg = await api('POST', '/api/devices/register', { kind: 'host', name: 'Desligado' });
    const p = await connectWs(phone.deviceId, phone.token, 'client');
    await p.next((m) => m.t === 'hello.ok');
    p.send({ t: 'connect', reqId: 'x1', hostId: reg.body.deviceId, clientNonce: 'b'.repeat(32) });
    expect((await p.next((m) => m.t === 'error' && m.reqId === 'x1')).code).toBe('HOST_OFFLINE');
    p.send({ t: 'connect', reqId: 'x2', hostId: '123456789', clientNonce: 'b'.repeat(32) });
    expect((await p.next((m) => m.t === 'error' && m.reqId === 'x2')).code).toBe('HOST_NOT_FOUND');
    p.send({ t: 'connect', reqId: 'x3', hostId: phone.deviceId, clientNonce: 'b'.repeat(32) });
    expect((await p.next((m) => m.t === 'error' && m.reqId === 'x3')).code).toBe('SELF_CONNECT');
  });

  it('limita tentativas de conexão (proteção contra força bruta)', async () => {
    const reg = await api('POST', '/api/devices/register', { kind: 'client', name: 'Robô' });
    const c = await connectWs(reg.body.deviceId, reg.body.token, 'client');
    await c.next((m) => m.t === 'hello.ok');
    const codes: string[] = [];
    for (let i = 0; i < 11; i++) {
      c.send({ t: 'connect', reqId: `q${i}`, hostId: '123456789', clientNonce: 'c'.repeat(32) });
      codes.push((await c.next((m) => m.t === 'error' && m.reqId === `q${i}`)).code);
    }
    expect(codes.slice(0, 10).every((x) => x === 'HOST_NOT_FOUND')).toBe(true);
    expect(codes[10]).toBe('RATE_LIMITED');
  });

  it('queda do computador encerra a sessão para o celular', async () => {
    const h = await connectWs(host.deviceId, host.token, 'host');
    await h.next((m) => m.t === 'hello.ok');
    const reg = await api('POST', '/api/devices/register', { kind: 'client', name: 'Tablet' });
    const p = await connectWs(reg.body.deviceId, reg.body.token, 'client');
    await p.next((m) => m.t === 'hello.ok');
    p.send({ t: 'connect', reqId: 'z', hostId: host.deviceId, clientNonce: 'd'.repeat(32) });
    await p.next((m) => m.t === 'session.created');
    h.ws.close();
    expect((await p.next((m) => m.t === 'session.ended')).reason).toBe('peer-disconnected');
  });

  it('contas: primeiro usuário é admin, login, refresh rotativo, detecção de reuso', async () => {
    const r1 = await api('POST', '/api/auth/register', { email: 'Dono@Exemplo.com', name: 'Dono', password: 'Senha-Forte-1' });
    expect(r1.status).toBe(201);
    expect(r1.body.user.role).toBe('admin');
    const r2 = await api('POST', '/api/auth/register', { email: 'outro@exemplo.com', name: 'Outro', password: 'Senha-Forte-2' });
    expect(r2.body.user.role).toBe('user');
    expect((await api('POST', '/api/auth/register', { email: 'dono@exemplo.com', name: 'X', password: 'Senha-Forte-3' })).status).toBe(409);

    expect((await api('POST', '/api/auth/login', { email: 'dono@exemplo.com', password: 'errada-123' })).status).toBe(401);
    const login = await api('POST', '/api/auth/login', { email: 'dono@exemplo.com', password: 'Senha-Forte-1' });
    expect(login.status).toBe(200);
    const bearer = `Bearer ${login.body.accessToken}`;
    expect((await api('GET', '/api/me', undefined, bearer)).body.user.email).toBe('dono@exemplo.com');

    const ref = await api('POST', '/api/auth/refresh', { refreshToken: login.body.refreshToken });
    expect(ref.status).toBe(200);
    expect(ref.body.refreshToken).not.toBe(login.body.refreshToken);
    const reuse = await api('POST', '/api/auth/refresh', { refreshToken: login.body.refreshToken });
    expect(reuse.body.error).toBe('REFRESH_REUSED');
    // o reuso revoga toda a família de tokens
    expect((await api('POST', '/api/auth/refresh', { refreshToken: ref.body.refreshToken })).status).toBe(401);

    // vincular dispositivo à conta e listar com status online
    const claim = await api('POST', '/api/devices/claim', { deviceId: host.deviceId, token: host.token }, bearer);
    expect(claim.status).toBe(200);
    const list = await api('GET', '/api/devices', undefined, bearer);
    expect(list.body.devices.map((d: any) => d.id)).toContain(host.deviceId);

    // administração
    const users = await api('GET', '/api/admin/users', undefined, bearer);
    expect(users.body.users.length).toBe(2);
    const other = users.body.users.find((u: any) => u.email === 'outro@exemplo.com');
    expect((await api('PATCH', `/api/admin/users/${other.id}`, { disabled: true }, bearer)).body.user.disabled).toBe(true);
    expect((await api('POST', '/api/auth/login', { email: 'outro@exemplo.com', password: 'Senha-Forte-2' })).status).toBe(403);
    const otherBearer = `Bearer ${r2.body.accessToken}`;
    expect((await api('GET', '/api/admin/users', undefined, otherBearer)).status).toBe(403);
    const audit = await api('GET', '/api/admin/audit?limit=200', undefined, bearer);
    expect(audit.body.entries.some((e: any) => e.action === 'session.authorized')).toBe(true);
  });

  it('bloqueia login após falhas repetidas', async () => {
    await api('POST', '/api/auth/register', { email: 'alvo@exemplo.com', name: 'Alvo', password: 'Senha-Forte-9' });
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await api('POST', '/api/auth/login', { email: 'alvo@exemplo.com', password: `errada-${i}xx` })).status;
    expect(last).toBe(429);
    expect((await api('POST', '/api/auth/login', { email: 'alvo@exemplo.com', password: 'Senha-Forte-9' })).status).toBe(429);
  });

  it('revogar dispositivo derruba a sinalização e invalida o token', async () => {
    const login = await api('POST', '/api/auth/login', { email: 'dono@exemplo.com', password: 'Senha-Forte-1' });
    const bearer = `Bearer ${login.body.accessToken}`;
    const reg = await api('POST', '/api/devices/register', { kind: 'host', name: 'Notebook' }, bearer);
    const c = await connectWs(reg.body.deviceId, reg.body.token, 'host');
    await c.next((m) => m.t === 'hello.ok');
    expect((await api('DELETE', `/api/devices/${reg.body.deviceId}`, undefined, bearer)).status).toBe(204);
    expect((await c.next((m) => m.t === 'error')).code).toBe('REVOKED');
    expect(await c.waitClose()).toBe(4003);
    expect((await api('GET', '/api/devices/me', undefined, `Device ${reg.body.deviceId}:${reg.body.token}`)).status).toBe(403);
  });
});
