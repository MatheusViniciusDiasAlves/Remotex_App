/** Cliente de sinalização do HOST: conexão WebSocket persistente com reconexão exponencial. */
import WebSocket from 'ws';
import { Emitter } from '@remotex/shared/emitter';
import { PROTOCOL_VERSION, APP_VERSION } from '@remotex/shared/version';
import type { ClientToServer, ServerToClient } from '@remotex/signaling/protocol';

export type SignalingStatus = 'offline' | 'connecting' | 'online' | 'unauthorized';

export class SignalingClient extends Emitter<{ status: SignalingStatus; message: ServerToClient; error: string }> {
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  status: SignalingStatus = 'offline';
  lastError = '';

  constructor(private readonly opts: { serverUrl: () => string; deviceId: () => string | null; token: () => string | null; name: () => string }) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    this.setStatus('offline');
  }

  restart(): void {
    this.stop();
    this.retry = 0;
    this.start();
  }

  send(msg: ClientToServer): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN || this.status !== 'online') return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private setStatus(s: SignalingStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  private connect(): void {
    const id = this.opts.deviceId();
    const token = this.opts.token();
    if (this.stopped || !id || !token) return;
    const url = this.opts.serverUrl().replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    } catch (err) {
      this.lastError = String(err);
      return this.scheduleReconnect();
    }
    this.ws = ws;
    ws.on('open', () => {
      ws.send(
        JSON.stringify({ t: 'hello', deviceId: id, token, kind: 'host', name: this.opts.name(), platform: process.platform, version: APP_VERSION, protocol: PROTOCOL_VERSION }),
      );
    });
    ws.on('message', (data) => {
      let msg: ServerToClient;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.t === 'hello.ok') {
        this.retry = 0;
        this.lastError = '';
        this.setStatus('online');
      } else if (msg.t === 'error' && (msg.code === 'UNAUTHORIZED' || msg.code === 'REVOKED')) {
        this.lastError = msg.message;
        this.setStatus('unauthorized');
        this.emit('error', msg.code);
      }
      this.emit('message', msg);
    });
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (code === 4001 || code === 4003) {
        this.setStatus('unauthorized');
        return; // credenciais inválidas: aguarda novo registro
      }
      if (code === 4002) {
        this.lastError = 'Outra instância do RemoteX assumiu este ID';
      }
      this.setStatus('offline');
      this.scheduleReconnect();
    });
    ws.on('error', (err) => {
      this.lastError = err.message;
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.min(30_000, 1000 * 2 ** this.retry) + Math.random() * 500;
    this.retry = Math.min(this.retry + 1, 6);
    this.timer = setTimeout(() => this.connect(), delay);
  }
}
