/** Conexão de sinalização do celular (WebSocket) com o servidor RemoteX. */
import { Emitter } from '@remotex/shared/emitter';
import { APP_VERSION, PROTOCOL_VERSION } from '@remotex/shared/version';
import type { ClientToServer, ServerToClient } from '@remotex/signaling/protocol';
import type { Identity } from './storage';

export type SigStatus = 'offline' | 'connecting' | 'online' | 'unauthorized';

export class ClientSignaling extends Emitter<{ status: SigStatus; message: ServerToClient }> {
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer: number | null = null;
  private wantOpen = false;
  private ready: Promise<void> | null = null;
  status: SigStatus = 'offline';

  constructor(
    private readonly serverUrl: () => string,
    private readonly identity: () => Identity | null,
    private readonly name: () => string,
  ) {
    super();
  }

  /** Abre (se necessário) e resolve quando autenticado. */
  open(): Promise<void> {
    this.wantOpen = true;
    if (this.status === 'online') return Promise.resolve();
    if (!this.ready) {
      this.ready = new Promise<void>((resolve, reject) => {
        const offOk = this.on('status', (s) => {
          if (s === 'online') {
            offOk();
            resolve();
          } else if (s === 'unauthorized') {
            offOk();
            reject(new Error('unauthorized'));
          }
        });
        setTimeout(() => {
          offOk();
          if (this.status !== 'online') reject(new Error('timeout'));
        }, 12_000);
      }).finally(() => (this.ready = null));
      this.connect();
    }
    return this.ready;
  }

  close(): void {
    this.wantOpen = false;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    this.setStatus('offline');
  }

  send(msg: ClientToServer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private setStatus(s: SigStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.emit('status', s);
  }

  private connect(): void {
    const id = this.identity();
    if (!id) return this.setStatus('unauthorized');
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    const url = this.serverUrl().replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return this.scheduleRetry();
    }
    this.ws = ws;
    ws.onopen = () =>
      ws.send(JSON.stringify({ t: 'hello', deviceId: id.deviceId, token: id.token, kind: 'client', name: this.name(), platform: 'android', version: APP_VERSION, protocol: PROTOCOL_VERSION }));
    ws.onmessage = (e) => {
      let m: ServerToClient;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (m.t === 'hello.ok') {
        this.retry = 0;
        this.setStatus('online');
      } else if (m.t === 'error' && (m.code === 'UNAUTHORIZED' || m.code === 'REVOKED')) {
        this.setStatus('unauthorized');
      }
      this.emit('message', m);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (e.code === 4001 || e.code === 4003) return this.setStatus('unauthorized');
      this.setStatus('offline');
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (!this.wantOpen) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.min(20_000, 800 * 2 ** this.retry);
    this.retry = Math.min(this.retry + 1, 5);
    this.timer = window.setTimeout(() => this.connect(), delay);
  }
}
