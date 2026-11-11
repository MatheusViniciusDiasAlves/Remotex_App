/**
 * Núcleo do HOST RemoteX: identidade/registro, sinalização, autorização, sessão WebRTC,
 * entrada remota, área de transferência, gravação, administração e indicadores visíveis.
 */
import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, Notification, session as eSession, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { ConfigStore, type HistoryEntry } from './config-store';
import { SignalingClient } from './signaling-client';
import { AuthManager, type ApprovalDecision } from './auth-manager';
import { RecordingStore } from './recordings';
import { findDisplay, isProcessElevated, listDisplays, lockWorkstation, physicalRect, relaunchElevated, setLaunchAtStartup } from './platform';
import { HostWindows } from './windows';
import { HostTray } from './tray';
import type { EngineCommand, EngineEvent } from '../shared/engine-ipc';
import type { ActiveSessionView, ApprovalRequestView, HostStateView } from '../shared/ui-ipc';
import { generateDeviceKeyPair, keyFingerprint, signMessage, verifySignature } from '@remotex/auth/device-keys';
import { bindingMessage, extractDtlsFingerprint, sessionVerificationCode } from '@remotex/auth/binding';
import { createPasswordVerifier, verifyHmacHex } from '@remotex/auth/password';
import { checkAccessPassword } from '@remotex/security/validation';
import { DEFAULT_GRANT, sanitizePermissions, type PermissionSet } from '@remotex/security/permissions';
import { InputDispatcher } from '@remotex/input/input-dispatcher';
import { createInjector } from '@remotex/input/injector-factory';
import type { InputInjector } from '@remotex/input/injector';
import { isInputEvent, MAX_CLIPBOARD_TEXT, type HostControlMessage, type RecordingState } from '@remotex/media/channel-protocol';
import { desktopToNormalized, type Rect } from '@remotex/capture/geometry';
import { handleAdminRpc, AdminError, type AdminHost } from '@remotex/admin/host-admin';
import { recordingFileName } from '@remotex/recording/recorder';
import type { AuthMethod, PeerInfo, RelayPayload, ServerToClient } from '@remotex/signaling/protocol';
import { formatDeviceId } from '@remotex/shared/ids';
import { APP_VERSION } from '@remotex/shared/version';

const DEBUG_INPUT = process.env.REMOTEX_DEBUG_INPUT === '1';

interface ActiveSession {
  id: string;
  client: PeerInfo;
  clientName: string;
  clientPublicKey: string;
  fingerprint: string;
  method: AuthMethod;
  permissions: PermissionSet;
  bindingKey: string | null;
  startedAt: number;
  connected: boolean;
  verified: boolean;
  hostFp: string | null;
  clientFp: string | null;
  sas: string | null;
  displayRect: Rect;
  recording: { target: 'host' | 'client'; state: RecordingState } | null;
  stats: ActiveSessionView['stats'];
  effective: string;
  timers: NodeJS.Timeout[];
  lastCursor: string;
  lastClipboard: string;
  lastBlockedNotice: number;
  disconnectTimer: NodeJS.Timeout | null;
  history: HistoryEntry;
}

export class HostApp {
  readonly store = new ConfigStore();
  readonly windows: HostWindows;
  readonly tray: HostTray;
  readonly auth: AuthManager;
  readonly recordings: RecordingStore;
  readonly signaling: SignalingClient;
  private injector: InputInjector | null = null;
  private dispatcher: InputDispatcher | null = null;
  private session: ActiveSession | null = null;
  private approvals = new Map<string, { view: ApprovalRequestView; timer: NodeJS.Timeout }>();
  private engineReady: Promise<void>;
  private resolveEngineReady!: () => void;
  private captureDisplayId: string | null = null;
  private status: HostStateView['status'] = 'offline';
  private statusMessage = '';
  private elevated = false;
  private stateTimer: NodeJS.Timeout | null = null;
  private quitting = false;

  constructor(private readonly opts: { background: boolean }) {
    this.auth = new AuthManager(this.store, () => this.store.get().deviceId || '');
    this.recordings = new RecordingStore(() => this.store.get().recording.dir);
    this.windows = new HostWindows();
    this.tray = new HostTray(this);
    this.engineReady = new Promise((r) => (this.resolveEngineReady = r));
    this.signaling = new SignalingClient({
      serverUrl: () => this.store.get().serverUrl,
      deviceId: () => this.store.get().deviceId,
      token: () => this.store.get().deviceToken,
      name: () => this.store.get().deviceName,
    });
  }

  // =========================================================================================
  // Inicialização
  // =========================================================================================
  async start(): Promise<void> {
    console.log('[host] verificando privilégios');
    this.elevated = await isProcessElevated();
    console.log(`[host] administrador: ${this.elevated}`);
    this.injector = await createInjector();
    console.log(`[host] injetor de entrada: ${this.injector.name}`);
    this.dispatcher = new InputDispatcher({
      injector: this.injector,
      getDisplayRect: () => this.session?.displayRect ?? physicalRect(findDisplay(this.captureDisplayId)),
      getPermissions: () => this.session?.permissions ?? sanitizePermissions({}),
      onBlocked: () => this.notifyInputBlocked(),
    });

    const c = this.store.get();
    if (!c.hostKey) this.store.update((cfg) => (cfg.hostKey = generateDeviceKeyPair()));
    console.log('[host] identidade criptográfica pronta');
    this.setupDisplayMedia();
    console.log('[host] captura de tela configurada');
    this.registerIpc();
    console.log('[host] IPC registrado');
    this.windows.createEngine();
    console.log('[host] janela de mídia criada');
    if (!this.opts.background) this.windows.showMain();
    this.tray.create();
    console.log('[host] janelas e bandeja criadas');

    this.signaling.on('status', (s) => {
      console.log(`[host] sinalização: ${s}${this.signaling.lastError ? ` (${this.signaling.lastError})` : ''}`);
      this.status = s;
      this.statusMessage = s === 'offline' ? this.signaling.lastError : '';
      this.pushState();
    });
    this.signaling.on('error', (code) => {
      if (code === 'UNAUTHORIZED') void this.register(true);
    });
    this.signaling.on('message', (m) => this.onSignal(m));

    await this.ensureRegistered();
    console.log(`[host] dispositivo ${this.store.get().deviceId ?? '(não registrado)'} no servidor ${this.store.get().serverUrl}`);
    this.signaling.start();
    this.pushState();
  }

  private setupDisplayMedia(): void {
    eSession.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        const wanted = this.captureDisplayId ?? String(findDisplay(null).id);
        const src = sources.find((s) => s.display_id === wanted) ?? sources[0];
        const wantAudio = process.platform === 'win32' && (this.session?.permissions.audio ?? false);
        callback(wantAudio ? { video: src, audio: 'loopback' } : { video: src });
      } catch (err) {
        console.error('[host] falha ao selecionar a tela para captura', err);
        callback({});
      }
    });
  }

  async ensureRegistered(): Promise<void> {
    const c = this.store.get();
    if (c.deviceId && c.deviceToken && c.registeredServer === c.serverUrl) return;
    await this.register(false);
  }

  async register(force: boolean): Promise<string | null> {
    const c = this.store.get();
    if (!force && c.deviceId && c.deviceToken && c.registeredServer === c.serverUrl) return null;
    this.status = 'registering';
    this.pushState();
    try {
      console.log(`[host] registrando em ${c.serverUrl}`);
      const res = await fetch(`${c.serverUrl.replace(/\/+$/, '')}/api/devices/register`, {
        signal: AbortSignal.timeout(15_000),
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'host', name: c.deviceName, platform: process.platform, appVersion: APP_VERSION, publicKey: c.hostKey!.publicKey }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
      this.store.update((cfg) => {
        cfg.deviceId = body.deviceId;
        cfg.deviceToken = body.token;
        cfg.registeredServer = cfg.serverUrl;
      });
      this.store.flush();
      this.signaling.restart();
      return null;
    } catch (err: any) {
      console.error('[host] falha no registro', err);
      this.status = 'error';
      this.statusMessage = `Não foi possível registrar no servidor ${c.serverUrl}: ${err.message || err}`;
      this.pushState();
      setTimeout(() => void this.ensureRegistered().then(() => this.signaling.restart()), 15_000);
      return this.statusMessage;
    }
  }

  private async updateServerDevice(): Promise<void> {
    const c = this.store.get();
    if (!c.deviceId || !c.deviceToken) return;
    await fetch(`${c.serverUrl.replace(/\/+$/, '')}/api/devices/me`, {
      signal: AbortSignal.timeout(15_000),
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Device ${c.deviceId}:${c.deviceToken}` },
      body: JSON.stringify({ name: c.deviceName }),
    }).catch(() => undefined);
  }

  // =========================================================================================
  // Sinalização e autorização
  // =========================================================================================
  private relay(sessionId: string, payload: RelayPayload): void {
    this.signaling.send({ t: 'relay', sessionId, payload });
  }

  private onSignal(m: ServerToClient): void {
    switch (m.t) {
      case 'session.incoming':
        return this.onIncoming(m.sessionId, m.client, m.clientNonce, m.iceServers);
      case 'relay':
        return this.onRelay(m.sessionId, m.payload);
      case 'session.ended':
        return this.onRemoteEnded(m.sessionId, m.reason);
      default:
        return;
    }
  }

  private iceServersFor = new Map<string, any[]>();

  private onIncoming(sessionId: string, client: PeerInfo, clientNonce: string, iceServers: any[]): void {
    console.log(`[host] pedido de acesso ${sessionId} de ${client.name} (${client.id}) ip=${client.ip ?? '?'}`);
    const c = this.store.get();
    const entry: HistoryEntry = {
      sessionId,
      clientId: client.id,
      clientName: client.name,
      clientFingerprint: '',
      ip: client.ip ?? null,
      method: null,
      result: 'rejected',
      requestedAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
    };
    const refuse = (code: 'DISABLED' | 'BUSY', reason: string) => {
      this.relay(sessionId, { k: 'auth.result', ok: false, code, reason });
      this.signaling.send({ t: 'session.state', sessionId, state: 'rejected', reason: code });
      this.signaling.send({ t: 'session.end', sessionId, reason: code.toLowerCase() });
      this.store.addHistory({ ...entry, reason });
      this.pushState();
    };
    if (!c.incomingEnabled) return refuse('DISABLED', 'Conexões remotas estão desativadas neste computador');
    if (this.session) return refuse('BUSY', 'O computador já está em uma sessão remota');
    if (this.auth.availableMethods().length === 0) return refuse('DISABLED', 'Nenhum método de acesso está habilitado neste computador');
    this.iceServersFor.set(sessionId, iceServers);
    this.store.addHistory({ ...entry, result: 'cancelled', reason: 'Aguardando autorização' });
    this.relay(sessionId, this.auth.begin(sessionId, client, clientNonce));
    this.signaling.send({ t: 'session.state', sessionId, state: 'authorizing' });
  }

  private onRelay(sessionId: string, payload: RelayPayload): void {
    if (!payload || typeof payload !== 'object') return;
    if (payload.k.startsWith('auth.')) return this.onAuthMessage(sessionId, payload);
    if (this.session?.id !== sessionId) return;
    if (payload.k === 'sdp' && payload.type === 'answer') {
      this.session.clientFp = extractDtlsFingerprint(payload.sdp);
      this.updateSas();
      this.engine({ type: 'signal', sessionId, payload });
    } else if (payload.k === 'ice') {
      this.engine({ type: 'signal', sessionId, payload });
    } else if (payload.k === 'bye') {
      this.endSession('Encerrada pelo celular', false);
    }
  }

  private onAuthMessage(sessionId: string, payload: RelayPayload): void {
    const out = this.auth.handle(sessionId, payload);
    if (!out) return;
    switch (out.type) {
      case 'reply':
        return this.relay(sessionId, out.payload);
      case 'approval':
        this.relay(sessionId, { k: 'auth.pending' });
        return this.openApproval(sessionId);
      case 'rejected': {
        this.relay(sessionId, out.payload);
        if (out.final) {
          this.signaling.send({ t: 'session.state', sessionId, state: 'rejected', reason: out.reason });
          setTimeout(() => this.signaling.send({ t: 'session.end', sessionId, reason: 'rejected' }), 300);
          this.updateHistory(sessionId, { result: 'rejected', reason: out.reason });
          this.closeApproval(sessionId);
        }
        this.pushState();
        return;
      }
      case 'authorized':
        return this.onAuthorized(sessionId, out);
    }
  }

  private onAuthorized(sessionId: string, out: Extract<NonNullable<ReturnType<AuthManager['handle']>>, { type: 'authorized' }>): void {
    console.log(`[host] sessão ${sessionId} autorizada (${out.method}) permissões=${Object.entries(out.permissions).filter(([, v]) => v).map(([k]) => k).join(',')}`);
    if (this.session) {
      this.relay(sessionId, { k: 'auth.result', ok: false, code: 'BUSY', reason: 'O computador já está em uma sessão' });
      this.signaling.send({ t: 'session.end', sessionId, reason: 'busy' });
      return;
    }
    this.relay(sessionId, out.payload);
    this.signaling.send({ t: 'session.state', sessionId, state: 'authorized', authMethod: out.method });
    this.beginSession(sessionId, {
      client: out.client,
      clientName: out.clientName,
      clientPublicKey: out.clientPublicKey,
      method: out.method,
      permissions: out.permissions,
      bindingKey: out.bindingKey,
    });
  }

  private openApproval(sessionId: string): void {
    const p = this.auth.get(sessionId);
    if (!p || !p.clientPublicKey) return;
    const c = this.store.get();
    const view: ApprovalRequestView = {
      sessionId,
      clientId: p.client.id,
      clientName: p.clientName,
      fingerprint: keyFingerprint(p.clientPublicKey),
      ip: p.client.ip ?? null,
      account: p.client.account ?? null,
      platform: p.client.platform,
      expiresAt: Date.now() + c.approvalTimeoutSec * 1000,
      suggested: { ...DEFAULT_GRANT },
      policy: c.policy,
    };
    const timer = setTimeout(() => this.decide(sessionId, 'timeout'), c.approvalTimeoutSec * 1000);
    this.approvals.set(sessionId, { view, timer });
    this.windows.showApproval(sessionId);
    this.notify('Pedido de acesso remoto', `${p.clientName} (${formatDeviceId(p.client.id)}) quer acessar este computador.`);
    this.pushState();
  }

  private closeApproval(sessionId: string): void {
    const a = this.approvals.get(sessionId);
    if (a) clearTimeout(a.timer);
    this.approvals.delete(sessionId);
    this.windows.closeApproval(sessionId);
  }

  decide(sessionId: string, d: ApprovalDecision | 'timeout'): void {
    if (!this.approvals.has(sessionId)) return;
    this.closeApproval(sessionId);
    const out = this.auth.decide(sessionId, d);
    if (out) this.onAuthOutcome(sessionId, out);
    if (d === 'timeout') this.updateHistory(sessionId, { result: 'timeout', reason: 'Sem resposta no computador' });
    this.pushState();
  }

  private onAuthOutcome(sessionId: string, out: ReturnType<AuthManager['decide']>): void {
    if (!out) return;
    if (out.type === 'rejected') {
      this.relay(sessionId, out.payload);
      this.signaling.send({ t: 'session.state', sessionId, state: 'rejected', reason: out.reason });
      setTimeout(() => this.signaling.send({ t: 'session.end', sessionId, reason: 'rejected' }), 300);
      this.updateHistory(sessionId, { result: 'rejected', reason: out.reason });
      return;
    }
    if (out.type === 'authorized') this.onAuthorized(sessionId, out);
  }

  private updateHistory(sessionId: string, patch: Partial<HistoryEntry>): void {
    const h = this.store.get().history.find((x) => x.sessionId === sessionId);
    if (h) this.store.addHistory({ ...h, ...patch });
  }

  // =========================================================================================
  // Sessão
  // =========================================================================================
  private beginSession(
    sessionId: string,
    a: { client: PeerInfo; clientName: string; clientPublicKey: string; method: AuthMethod; permissions: PermissionSet; bindingKey: string | null },
  ): void {
    const c = this.store.get();
    const fp = keyFingerprint(a.clientPublicKey);
    const history = c.history.find((h) => h.sessionId === sessionId) ?? {
      sessionId,
      clientId: a.client.id,
      clientName: a.clientName,
      clientFingerprint: fp,
      ip: a.client.ip ?? null,
      method: a.method,
      result: 'failed' as const,
      requestedAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
    };
    this.captureDisplayId = this.captureDisplayId ?? String(findDisplay(null).id);
    this.session = {
      id: sessionId,
      client: a.client,
      clientName: a.clientName,
      clientPublicKey: a.clientPublicKey,
      fingerprint: fp,
      method: a.method,
      permissions: a.permissions,
      bindingKey: a.bindingKey,
      startedAt: Date.now(),
      connected: false,
      verified: false,
      hostFp: null,
      clientFp: null,
      sas: null,
      displayRect: physicalRect(findDisplay(this.captureDisplayId)),
      recording: null,
      stats: null,
      effective: '',
      timers: [],
      lastCursor: '',
      lastClipboard: '',
      lastBlockedNotice: 0,
      disconnectTimer: null,
      history: { ...history, clientName: a.clientName, clientFingerprint: fp, method: a.method, result: 'failed', reason: 'Conexão não estabelecida' },
    };
    this.store.addHistory(this.session.history);
    const s = this.session;
    void clipboard.readText().then((t) => (s.lastClipboard = t)).catch(() => undefined);
    // Prazo para a conexão WebRTC + amarração do canal completarem.
    s.timers.push(
      setTimeout(() => {
        if (this.session === s && !s.verified) this.endSession('Tempo esgotado ao estabelecer a conexão', true);
      }, 45_000),
    );
    void this.engineReady.then(() =>
      this.engine({
        type: 'start',
        sessionId,
        iceServers: this.iceServersFor.get(sessionId) ?? [],
        captureAudio: process.platform === 'win32' && a.permissions.audio,
        quality: c.quality.preset,
        codec: c.quality.codec,
        audioQuality: c.audio.quality,
      }),
    );
    this.pushState();
  }

  private updateSas(): void {
    const s = this.session;
    if (s && s.hostFp && s.clientFp) s.sas = sessionVerificationCode(s.hostFp, s.clientFp);
  }

  private engine(cmd: EngineCommand): void {
    this.windows.engine?.webContents.send('engine:command', cmd);
  }

  private sendControl(msg: HostControlMessage): void {
    if (this.session) this.engine({ type: 'send', sessionId: this.session.id, channel: 'control', msg });
  }

  private onEngineEvent(ev: EngineEvent): void {
    if (ev.type === 'ready') return this.resolveEngineReady();
    const s = this.session;
    if (!s || ev.sessionId !== s.id) return;
    switch (ev.type) {
      case 'signal':
        if (ev.payload.k === 'sdp') {
          s.hostFp = extractDtlsFingerprint(ev.payload.sdp);
          this.updateSas();
        }
        return this.relay(s.id, ev.payload);
      case 'channel-open':
        return this.sendWelcome();
      case 'state':
        if (ev.state === 'connected') {
          s.connected = true;
          if (s.disconnectTimer) clearTimeout(s.disconnectTimer);
          s.disconnectTimer = null;
        } else if (ev.state === 'disconnected') {
          s.connected = false;
          s.disconnectTimer ??= setTimeout(() => this.endSession('Conexão perdida', false), 15_000);
        } else if (ev.state === 'failed' || ev.state === 'closed') {
          this.endSession(ev.state === 'failed' ? 'Falha na conexão de rede' : 'Conexão encerrada', false);
        }
        return this.pushState();
      case 'control':
        return this.onControl(ev.msg);
      case 'motion':
        if (s.verified && ev.msg?.k === 'mv') {
          const r = this.dispatcher!.handle(ev.msg);
          if (DEBUG_INPUT) console.log('[motion]', JSON.stringify(ev.msg), '→', JSON.stringify(r));
        }
        return;
      case 'stats':
        s.stats = {
          kbps: ev.stats.kbps,
          fps: ev.stats.fps,
          rttMs: ev.stats.rttMs,
          path: ev.stats.path,
          codec: ev.stats.codec,
          encoder: ev.stats.encoder,
          width: ev.stats.width,
          height: ev.stats.height,
        };
        s.effective = ev.effective;
        return this.pushState();
      case 'rec-state':
        return void this.onRecState(ev.state, ev.mime, ev.message);
      case 'capture':
        console.log(`[host] captura ${ev.width}x${ev.height} áudio=${ev.audio} fonte="${ev.label}"`);
        s.displayRect = physicalRect(findDisplay(this.captureDisplayId));
        return this.pushState();
      case 'error':
        console.error('[engine]', ev.message);
        if (!s.connected && /NotAllowed|NotFound|NotReadable|getDisplayMedia/i.test(ev.message)) {
          this.sendControl({ k: 'notice', level: 'error', message: `Falha ao capturar a tela: ${ev.message}` });
        }
        return;
    }
  }

  private sendWelcome(): void {
    const s = this.session!;
    const c = this.store.get();
    const bind = s.hostFp && s.clientFp ? signMessage(c.hostKey!.secretKey, bindingMessage(s.id, s.hostFp, s.clientFp)) : '';
    const msg: HostControlMessage & { hostBind: string } = {
      k: 'welcome',
      hostName: c.deviceName,
      os: `${process.platform === 'win32' ? 'Windows' : process.platform} ${process.getSystemVersion?.() ?? ''}`.trim(),
      permissions: s.permissions,
      displays: listDisplays(),
      activeDisplay: this.captureDisplayId ?? '',
      sas: s.sas,
      quality: c.quality.preset,
      audioAvailable: process.platform === 'win32',
      elevated: this.elevated,
      hostBind: bind,
    };
    this.sendControl(msg as HostControlMessage);
    // A conexão só é considerada ativa após a prova de amarração do celular (bind).
    s.timers.push(
      setTimeout(() => {
        if (this.session === s && !s.verified) this.endSession('O celular não confirmou a identidade do canal', true);
      }, 15_000),
    );
  }

  private verifyBinding(proof: string): boolean {
    const s = this.session!;
    if (!s.hostFp || !s.clientFp || typeof proof !== 'string') return false;
    const msg = bindingMessage(s.id, s.hostFp, s.clientFp);
    if (s.method === 'password' && s.bindingKey) return verifyHmacHex(s.bindingKey, msg, proof);
    return verifySignature(s.clientPublicKey, msg, proof);
  }

  private onVerified(): void {
    const s = this.session!;
    const c = this.store.get();
    s.verified = true;
    s.startedAt = Date.now();
    this.signaling.send({ t: 'session.state', sessionId: s.id, state: 'active' });
    s.history = { ...s.history, result: 'connected', reason: undefined, startedAt: new Date().toISOString() };
    this.store.addHistory(s.history);
    this.windows.showBanner();
    this.notify('Sessão remota iniciada', `${s.clientName} está acessando este computador.`);
    if (c.audio.enabledByDefault && s.permissions.audio) this.engine({ type: 'audio', sessionId: s.id, enabled: true });
    // posição do cursor (para o cursor local no modo mouse do celular)
    s.timers.push(setInterval(() => this.pushCursor(), 50));
    // área de transferência do PC → celular
    if (s.permissions.clipboard) s.timers.push(setInterval(() => void this.pollClipboard(), 1000));
    this.pushState();
  }

  private pushCursor(): void {
    const s = this.session;
    if (!s?.verified || !this.injector) return;
    const p = this.injector.cursorPosition();
    if (!p) return;
    const n = desktopToNormalized(p.x, p.y, s.displayRect);
    const key = `${n.x.toFixed(4)},${n.y.toFixed(4)}`;
    if (key === s.lastCursor) return;
    s.lastCursor = key;
    this.engine({ type: 'send', sessionId: s.id, channel: 'motion', msg: { k: 'cur', x: Number(n.x.toFixed(5)), y: Number(n.y.toFixed(5)) } });
  }

  private async pollClipboard(): Promise<void> {
    const s = this.session;
    if (!s?.verified || !s.permissions.clipboard) return;
    const t = await clipboard.readText().catch(() => '');
    if (this.session !== s) return;
    if (t && t !== s.lastClipboard && t.length <= MAX_CLIPBOARD_TEXT) {
      s.lastClipboard = t;
      this.sendControl({ k: 'clip', text: t });
    }
  }

  private notifyInputBlocked(): void {
    const s = this.session;
    if (!s || Date.now() - s.lastBlockedNotice < 5000) return;
    s.lastBlockedNotice = Date.now();
    this.sendControl({
      k: 'notice',
      level: 'warn',
      code: 'INPUT_BLOCKED',
      message:
        'O Windows bloqueou o controle desta janela porque ela pertence a um programa executado como administrador. ' +
        'Use "Solicitar modo administrador" (alguém no computador precisará aprovar o UAC).',
    });
  }

  private scheduleCaretCheck(): void {
    const s = this.session;
    if (!s || !this.injector) return;
    setTimeout(() => {
      if (this.session !== s) return;
      const editable = this.injector!.caretActive();
      if (editable !== null) this.sendControl({ k: 'ime', editable });
    }, 180);
  }

  private onControl(msg: any): void {
    const s = this.session;
    if (DEBUG_INPUT) console.log('[control]', msg?.k, s ? `verified=${s.verified}` : 'sem sessão');
    if (!s || !msg || typeof msg.k !== 'string') return;
    if (msg.k === 'bind') {
      if (s.verified) return;
      const ok = this.verifyBinding(msg.proof);
      this.sendControl({ k: 'bind.result', ok });
      if (ok) this.onVerified();
      else {
        this.notify('Conexão bloqueada', 'A verificação de segurança do canal falhou (possível interceptação). A sessão foi encerrada.');
        this.endSession('Falha na verificação de segurança do canal', true);
      }
      return;
    }
    if (msg.k === 'hello') return;
    if (!s.verified) return;

    if (isInputEvent(msg)) {
      const r = this.dispatcher!.handle(msg);
      if (DEBUG_INPUT) console.log('[input]', JSON.stringify(msg), '→', JSON.stringify(r), JSON.stringify(s.displayRect));
      if (r.reason === 'forbidden') this.forbidden(msg.k === 'text' || msg.k === 'key' || msg.k === 'combo' ? 'teclado' : 'controle do mouse');
      if (r.ok && (msg.k === 'click' || (msg.k === 'btn' && !msg.down))) this.scheduleCaretCheck();
      return;
    }
    switch (msg.k) {
      case 'quality':
        if (['auto', 'high', 'balanced', 'economy'].includes(msg.preset)) {
          this.engine({ type: 'quality', sessionId: s.id, preset: msg.preset, original: Boolean(msg.original) });
        }
        return;
      case 'audio':
        if (!s.permissions.audio) return this.forbidden('áudio');
        return this.engine({ type: 'audio', sessionId: s.id, enabled: Boolean(msg.enabled), quality: ['low', 'medium', 'high'].includes(msg.quality) ? msg.quality : undefined });
      case 'mic':
        if (!s.permissions.microphone) {
          this.engine({ type: 'mic', sessionId: s.id, allowed: false });
          return this.forbidden('microfone');
        }
        return this.engine({ type: 'mic', sessionId: s.id, allowed: Boolean(msg.enabled) });
      case 'clip':
        if (!s.permissions.clipboard) return this.forbidden('área de transferência');
        if (typeof msg.text === 'string' && msg.text.length <= MAX_CLIPBOARD_TEXT) {
          s.lastClipboard = msg.text;
          void clipboard.writeText(msg.text).catch(() => undefined);
        }
        return;
      case 'clip.get':
        if (!s.permissions.clipboard) return this.forbidden('área de transferência');
        void clipboard
          .readText()
          .then((text) => this.sendControl({ k: 'clip', text: text.slice(0, MAX_CLIPBOARD_TEXT) }))
          .catch(() => undefined);
        return;
      case 'rec':
        return void this.onRecRequest(msg);
      case 'display': {
        const d = listDisplays().find((x) => x.id === String(msg.id));
        if (!d) return;
        this.captureDisplayId = d.id;
        s.displayRect = physicalRect(findDisplay(d.id));
        this.engine({ type: 'display', sessionId: s.id });
        this.sendControl({ k: 'display', activeDisplay: d.id, displays: listDisplays() });
        return;
      }
      case 'special':
        return void this.onSpecial(msg.action);
      case 'rpc':
        return void this.onRpc(msg);
      case 'cstats':
        return;
      case 'bye':
        return this.endSession('Encerrada pelo celular', false);
      default:
        return;
    }
  }

  private forbidden(what: string): void {
    this.sendControl({ k: 'notice', level: 'warn', code: 'FORBIDDEN', message: `Permissão negada pelo computador: ${what}.` });
  }

  private async onSpecial(action: string): Promise<void> {
    const s = this.session!;
    if (!s.permissions.keyboard) return this.forbidden('teclado');
    if (action === 'task-manager') {
      this.dispatcher!.handle({ k: 'combo', codes: ['ControlLeft', 'ShiftLeft', 'Escape'] });
    } else if (action === 'lock') {
      const ok = await lockWorkstation();
      if (!ok) this.sendControl({ k: 'notice', level: 'warn', message: 'Bloqueio de tela disponível apenas no Windows.' });
    } else if (action === 'ctrl-alt-del') {
      this.sendControl({
        k: 'notice',
        level: 'info',
        code: 'SAS_UNSUPPORTED',
        message:
          'Por segurança, o Windows não permite que programas simulem Ctrl+Alt+Del (sequência de atenção segura). ' +
          'Use "Gerenciador de Tarefas" (Ctrl+Shift+Esc) ou "Bloquear computador".',
      });
    }
  }

  // ---- gravação ---------------------------------------------------------------------------
  private async onRecRequest(msg: { action: string; target: 'host' | 'client'; quality?: any; audio?: boolean }): Promise<void> {
    const s = this.session!;
    const target = msg.target === 'client' ? 'client' : 'host';
    if (!s.permissions.recording) {
      this.sendControl({ k: 'rec.state', target, state: 'denied', message: 'O computador não autorizou gravações para este dispositivo.' });
      return;
    }
    const c = this.store.get();
    if (target === 'client') {
      // A gravação acontece no celular; o computador autoriza e exibe o indicador.
      const state: RecordingState = msg.action === 'stop' ? 'stopped' : msg.action === 'pause' ? 'paused' : 'recording';
      s.recording = state === 'stopped' ? null : { target, state };
      this.sendControl({ k: 'rec.state', target, state });
      this.windows.showBanner();
      return this.pushState();
    }
    switch (msg.action) {
      case 'start': {
        if (s.recording) return;
        const quality = ['low', 'medium', 'high'].includes(msg.quality) ? msg.quality : c.recording.quality;
        s.recording = { target, state: 'pending' };
        this.pendingRecStart = true;
        this.engine({ type: 'rec-start', sessionId: s.id, quality, includeAudio: Boolean(msg.audio) && (s.permissions.audio || s.permissions.microphone) });
        return;
      }
      case 'pause':
        return this.engine({ type: 'rec-pause', sessionId: s.id });
      case 'resume':
        return this.engine({ type: 'rec-resume', sessionId: s.id });
      case 'stop':
        return this.engine({ type: 'rec-stop', sessionId: s.id });
    }
  }

  private pendingRecStart = false;

  private async onRecState(state: 'recording' | 'paused' | 'stopped' | 'error', mime?: string, message?: string): Promise<void> {
    const s = this.session;
    if (state === 'recording' && this.pendingRecStart) {
      // o arquivo é criado quando o formato real (MP4 ou WebM) escolhido pelo MediaRecorder é conhecido
      this.pendingRecStart = false;
      this.recordings.begin(recordingFileName('RemoteX', mime || 'video/webm'));
    }
    if (state === 'stopped' || state === 'error') {
      const file = await this.recordings.finish();
      if (s) {
        s.recording = null;
        this.sendControl({ k: 'rec.state', target: 'host', state: state === 'error' ? 'error' : 'stopped', file: file ? path.basename(file) : undefined, message });
      }
    } else if (s) {
      s.recording = { target: 'host', state };
      this.sendControl({ k: 'rec.state', target: 'host', state });
      this.windows.showBanner();
    }
    this.pushState();
  }

  // ---- administração remota ------------------------------------------------------------------
  private adminHost(): AdminHost {
    return {
      overview: () => {
        const v = this.stateView();
        return {
          deviceId: v.deviceId,
          deviceName: v.deviceName,
          platform: v.platform,
          version: v.version,
          elevated: v.elevated,
          incomingEnabled: v.incomingEnabled,
          attendedEnabled: v.attendedEnabled,
          unattendedEnabled: v.unattendedEnabled,
          hasPassword: v.hasPassword,
          policy: v.policy,
          displays: listDisplays(),
        };
      },
      listTrusted: () => this.store.get().trusted.map(({ publicKey: _pk, ...t }) => t),
      updateTrusted: (deviceId, patch) => {
        let found = false;
        this.store.update((c) => {
          for (const t of c.trusted) {
            if (t.deviceId !== deviceId) continue;
            found = true;
            if (patch.permissions) t.permissions = patch.permissions;
            if (patch.unattended !== undefined) t.unattended = patch.unattended;
            if (patch.name) t.name = patch.name;
          }
        });
        this.pushState();
        return found;
      },
      revokeTrusted: (deviceId) => {
        const before = this.store.get().trusted.length;
        this.store.update((c) => (c.trusted = c.trusted.filter((t) => t.deviceId !== deviceId)));
        this.pushState();
        return this.store.get().trusted.length !== before;
      },
      history: (limit) => this.store.get().history.slice(0, limit),
      setIncoming: (v) => this.setIncoming(v),
      setAttended: (v) => (this.store.update((c) => (c.attendedEnabled = v)), this.pushState()),
      setUnattended: (v) => (this.store.update((c) => (c.unattendedEnabled = v)), this.pushState()),
      setPolicy: (p) => (this.store.update((c) => (c.policy = p)), this.pushState()),
      listRecordings: async () => this.recordings.list().map(({ name, size, createdAt }) => ({ name, size, createdAt })),
      requestElevation: async () => {
        this.notify('Solicitação de modo administrador', 'O usuário remoto pediu para reiniciar o RemoteX como administrador. Aprove o UAC se concordar.');
        const r = await relaunchElevated();
        if (r.ok) setTimeout(() => this.quit(), 500);
        return r;
      },
    };
  }

  private async onRpc(msg: { id: number; method: string; params?: Record<string, unknown> }): Promise<void> {
    const s = this.session!;
    try {
      const result = await handleAdminRpc(this.adminHost(), s.permissions, String(msg.method), msg.params ?? {}, s.client.id);
      this.sendControl({ k: 'rpc.res', id: msg.id, ok: true, result });
    } catch (err) {
      this.sendControl({ k: 'rpc.res', id: msg.id, ok: false, error: err instanceof AdminError ? err.message : 'Erro interno' });
      if (!(err instanceof AdminError)) console.error('[admin]', err);
    }
  }

  // ---- encerramento --------------------------------------------------------------------------
  private onRemoteEnded(sessionId: string, reason: string): void {
    if (this.approvals.has(sessionId)) {
      this.closeApproval(sessionId);
      this.auth.drop(sessionId);
      this.updateHistory(sessionId, { result: 'cancelled', reason: 'Cancelado pelo celular' });
    }
    if (this.session?.id === sessionId) this.endSession(reason === 'user' ? 'Encerrada pelo celular' : `Encerrada (${reason})`, false);
    this.pushState();
  }

  endSession(reason: string, notifyPeer = true): void {
    const s = this.session;
    if (!s) return;
    console.log(`[host] sessão ${s.id} encerrada: ${reason}`);
    this.session = null;
    for (const t of s.timers) clearTimeout(t);
    if (s.disconnectTimer) clearTimeout(s.disconnectTimer);
    this.dispatcher?.releaseAll();
    if (notifyPeer) {
      this.engine({ type: 'send', sessionId: s.id, channel: 'control', msg: { k: 'bye', reason } });
      this.relay(s.id, { k: 'bye', reason });
    }
    this.engine({ type: 'stop', sessionId: s.id });
    void this.recordings.finish();
    this.signaling.send({ t: 'session.end', sessionId: s.id, reason: notifyPeer ? 'host-ended' : 'ended' });
    const ok = s.verified;
    this.store.addHistory({ ...s.history, result: ok ? 'connected' : 'failed', reason, endedAt: new Date().toISOString() });
    this.iceServersFor.delete(s.id);
    this.windows.hideBanner();
    if (ok) this.notify('Sessão remota encerrada', `${s.clientName}: ${reason}`);
    this.pushState();
  }

  setIncoming(v: boolean): void {
    this.store.update((c) => (c.incomingEnabled = v));
    if (!v && this.session) this.endSession('Conexões remotas desativadas no computador');
    this.pushState();
  }

  quit(): void {
    this.quitting = true;
    if (this.session) this.endSession('O RemoteX foi fechado no computador');
    this.signaling.stop();
    this.store.flush();
    setTimeout(() => app.quit(), 200);
  }

  get isQuitting(): boolean {
    return this.quitting;
  }

  private notify(title: string, body: string): void {
    try {
      if (Notification.isSupported()) new Notification({ title, body, silent: false }).show();
    } catch {
      /* notificações indisponíveis */
    }
  }

  // =========================================================================================
  // Estado para a interface
  // =========================================================================================
  stateView(): HostStateView {
    const c = this.store.get();
    const s = this.session;
    return {
      deviceId: c.deviceId,
      deviceName: c.deviceName,
      serverUrl: c.serverUrl,
      status: this.status,
      statusMessage: this.statusMessage,
      hostFingerprint: c.hostKey ? keyFingerprint(c.hostKey.publicKey) : '',
      incomingEnabled: c.incomingEnabled,
      attendedEnabled: c.attendedEnabled,
      unattendedEnabled: c.unattendedEnabled,
      hasPassword: Boolean(c.password),
      passwordLockedForMs: this.auth.lockout.isLocked('password'),
      policy: c.policy,
      passwordPermissions: c.passwordPermissions,
      trusted: c.trusted.map(({ publicKey: _pk, ...t }) => t),
      history: c.history.slice(0, 200),
      quality: c.quality,
      audio: c.audio,
      recording: { dir: this.recordings.dir, quality: c.recording.quality },
      launchAtStartup: c.launchAtStartup,
      runInBackground: c.runInBackground,
      approvalTimeoutSec: c.approvalTimeoutSec,
      elevated: this.elevated,
      platform: process.platform,
      version: APP_VERSION,
      session: s
        ? {
            sessionId: s.id,
            clientId: s.client.id,
            clientName: s.clientName,
            clientFingerprint: s.fingerprint,
            ip: s.client.ip ?? null,
            method: s.method,
            permissions: s.permissions,
            startedAt: s.startedAt,
            connected: s.connected,
            verified: s.verified,
            sas: s.sas,
            recording: s.recording,
            stats: s.stats,
            quality: s.effective,
          }
        : null,
      approvals: [...this.approvals.values()].map((a) => a.view),
    };
  }

  pushState(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      const v = this.stateView();
      this.windows.broadcast('ui:state', v);
      this.tray.update(v);
    }, 40);
  }

  // =========================================================================================
  // IPC
  // =========================================================================================
  private registerIpc(): void {
    ipcMain.on('engine:event', (e, ev: EngineEvent) => {
      if (e.sender !== this.windows.engine?.webContents) return;
      this.onEngineEvent(ev);
    });
    ipcMain.handle('engine:rec-chunk', async (e, sessionId: string, data: ArrayBuffer) => {
      if (e.sender !== this.windows.engine?.webContents || this.session?.id !== sessionId) return;
      await this.recordings.write(data);
    });

    const h = (name: string, fn: (...args: any[]) => any) =>
      ipcMain.handle(`ui:${name}`, async (e, ...args) => {
        if (!this.windows.isUiSender(e.sender)) throw new Error('origem não autorizada');
        return fn(...args);
      });

    h('getState', () => this.stateView());
    h('setIncoming', (v: boolean) => this.setIncoming(Boolean(v)));
    h('setAttended', (v: boolean) => (this.store.update((c) => (c.attendedEnabled = Boolean(v))), this.pushState()));
    h('setUnattended', (v: boolean) => (this.store.update((c) => (c.unattendedEnabled = Boolean(v))), this.pushState()));
    h('setPassword', async (pw: string | null) => {
      if (pw === null) {
        this.store.update((c) => (c.password = null));
        this.pushState();
        return null;
      }
      const err = checkAccessPassword(String(pw));
      if (err) return err;
      const verifier = await createPasswordVerifier(String(pw));
      this.store.update((c) => (c.password = verifier));
      this.store.flush();
      this.pushState();
      return null;
    });
    h('setPolicy', (p: PermissionSet) => (this.store.update((c) => (c.policy = sanitizePermissions(p))), this.pushState()));
    h('setPasswordPermissions', (p: PermissionSet) => (this.store.update((c) => (c.passwordPermissions = sanitizePermissions(p))), this.pushState()));
    h('updateTrusted', (fp: string, patch: any) => {
      this.store.update((c) => {
        const t = c.trusted.find((x) => x.fingerprint === fp);
        if (!t) return;
        if (patch.permissions) t.permissions = sanitizePermissions(patch.permissions);
        if (typeof patch.unattended === 'boolean') t.unattended = patch.unattended;
        if (typeof patch.name === 'string' && patch.name.trim()) t.name = patch.name.trim().slice(0, 64);
      });
      this.pushState();
    });
    h('revokeTrusted', (fp: string) => {
      this.store.update((c) => (c.trusted = c.trusted.filter((t) => t.fingerprint !== fp)));
      if (this.session?.fingerprint === fp) this.endSession('Dispositivo revogado no computador');
      this.pushState();
    });
    h('setDeviceName', async (name: string) => {
      const n = String(name || '').trim().slice(0, 64);
      if (!n) return;
      this.store.update((c) => (c.deviceName = n));
      await this.updateServerDevice();
      this.pushState();
    });
    h('setServerUrl', async (url: string) => {
      let u: URL;
      try {
        u = new URL(String(url));
        if (!/^https?:$/.test(u.protocol)) throw new Error();
      } catch {
        return 'Endereço inválido. Exemplo: https://remotex.suaempresa.com.br';
      }
      this.store.update((c) => (c.serverUrl = u.origin));
      const err = await this.register(true);
      return err;
    });
    h('reregister', () => this.register(true));
    h('setQuality', (q: any) => {
      this.store.update((c) => {
        if (['auto', 'high', 'balanced', 'economy'].includes(q?.preset)) c.quality.preset = q.preset;
        if (['auto', 'h264', 'vp9', 'vp8', 'av1'].includes(q?.codec)) c.quality.codec = q.codec;
      });
      this.pushState();
    });
    h('setAudio', (a: any) => {
      this.store.update((c) => {
        if (['low', 'medium', 'high'].includes(a?.quality)) c.audio.quality = a.quality;
        if (typeof a?.enabledByDefault === 'boolean') c.audio.enabledByDefault = a.enabledByDefault;
      });
      this.pushState();
    });
    h('setRecording', (r: any) => {
      this.store.update((c) => {
        if (['low', 'medium', 'high'].includes(r?.quality)) c.recording.quality = r.quality;
      });
      this.pushState();
    });
    h('chooseRecordingDir', async () => {
      const win = this.windows.main;
      const opts = { properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>, defaultPath: this.recordings.dir };
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      if (!r.canceled && r.filePaths[0]) this.store.update((c) => (c.recording.dir = r.filePaths[0]));
      this.pushState();
    });
    h('setLaunchAtStartup', (v: boolean) => {
      this.store.update((c) => (c.launchAtStartup = Boolean(v)));
      setLaunchAtStartup(Boolean(v));
      this.pushState();
    });
    h('setRunInBackground', (v: boolean) => (this.store.update((c) => (c.runInBackground = Boolean(v))), this.pushState()));
    h('setApprovalTimeout', (sec: number) => {
      const v = Math.max(15, Math.min(300, Math.round(Number(sec) || 60)));
      this.store.update((c) => (c.approvalTimeoutSec = v));
      this.pushState();
    });
    h('endSession', () => this.endSession('Encerrada no computador'));
    h('stopRecording', () => {
      const s = this.session;
      if (!s?.recording) return;
      if (s.recording.target === 'host') this.engine({ type: 'rec-stop', sessionId: s.id });
      else {
        s.recording = null;
        this.sendControl({ k: 'rec.state', target: 'client', state: 'denied', message: 'Gravação interrompida no computador.' });
        this.pushState();
      }
    });
    h('listRecordings', () => this.recordings.list());
    h('openRecording', (name: string) => {
      const p = this.recordings.resolve(name);
      if (p) void shell.openPath(p);
    });
    h('showRecordingsFolder', () => void shell.openPath(this.recordings.dir));
    h('deleteRecording', (name: string) => {
      const p = this.recordings.resolve(name);
      if (p && p !== this.recordings.currentFile) fs.rmSync(p, { force: true });
    });
    h('relaunchElevated', async () => {
      const r = await relaunchElevated();
      if (r.ok) setTimeout(() => this.quit(), 500);
      return r;
    });
    h('copyId', () => clipboard.writeText(formatDeviceId(this.store.get().deviceId || '')));
    h('clearHistory', () => (this.store.update((c) => (c.history = [])), this.pushState()));
    h('decide', (sessionId: string, d: any) =>
      this.decide(String(sessionId), {
        accept: Boolean(d?.accept),
        permissions: sanitizePermissions(d?.permissions),
        trust: Boolean(d?.trust),
        unattended: Boolean(d?.unattended),
      }),
    );
    h('showMain', () => this.windows.showMain());
  }
}
