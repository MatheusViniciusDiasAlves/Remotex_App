/**
 * Conexão do celular com um computador:
 *  1. pede a conexão pelo ID (servidor de sinalização);
 *  2. confere a assinatura do computador e a chave fixada (alerta se mudou);
 *  3. autentica ponta a ponta: dispositivo confiável → senha lembrada → senha/aprovação;
 *  4. negocia o WebRTC (o computador oferece; o celular responde);
 *  5. confirma a amarração DTLS (anti-interceptação) e só então libera o controle.
 */
import { Emitter } from '@remotex/shared/emitter';
import { randomToken } from '@remotex/shared/ids';
import { clientIdentityMessage, hostIdentityMessage, keyFingerprint, signMessage, verifySignature } from '@remotex/auth/device-keys';
import { computeAuthProof, deriveAccessKey, hmacHex, isAcceptableScrypt, type ScryptParams } from '@remotex/auth/password';
import { bindingMessage, extractDtlsFingerprint, sessionVerificationCode } from '@remotex/auth/binding';
import { toHex } from '@remotex/shared/encoding';
import { CONTROL_CHANNEL, MOTION_CHANNEL, type ClientControlMessage, type HostControlMessage, type MotionMessage } from '@remotex/media/channel-protocol';
import { InboundStatsTracker, type InboundSummary } from '@remotex/media/stats';
import { MIC_CONSTRAINTS } from '@remotex/audio/audio-config';
import type { AuthMethod, IceServer, RelayPayload, ServerToClient } from '@remotex/signaling/protocol';
import type { PermissionSet } from '@remotex/security/permissions';
import type { ClientSignaling } from './signaling';
import { store, type Identity } from './storage';

export type Phase = 'signaling' | 'requesting' | 'auth' | 'waiting-approval' | 'connecting' | 'verifying' | 'connected' | 'ended';

export interface AuthNeeded {
  hostName: string;
  password: boolean;
  approval: boolean;
  error?: string;
  lockedForMs?: number;
}

export interface HostKeyChange {
  hostName: string;
  oldFingerprint: string;
  newFingerprint: string;
}

type Welcome = Extract<HostControlMessage, { k: 'welcome' }> & { hostBind?: string };

export class RemoteConnection extends Emitter<{
  phase: Phase;
  'auth-needed': AuthNeeded;
  'host-key-changed': HostKeyChange;
  stream: MediaStream;
  welcome: Welcome;
  verified: { sas: string };
  control: HostControlMessage;
  cursor: { x: number; y: number };
  stats: InboundSummary;
  ended: { reason: string; error: boolean };
}> {
  phase: Phase = 'signaling';
  sessionId = '';
  hostId = '';
  hostName = '';
  method: AuthMethod | null = null;
  permissions: PermissionSet | null = null;
  welcome: Welcome | null = null;
  sas = '';
  stream: MediaStream | null = null;
  private reqId = randomToken(8);
  private clientNonce = randomToken(16);
  private hostNonce = '';
  private hostPublicKey = '';
  private methods: AuthMethod[] = [];
  private passwordInfo: { salt: string; params: ScryptParams } | null = null;
  private bindingKey: string | null = null;
  private triedDevice = false;
  private triedSavedKey = false;
  private rememberKey: { salt: string; params: ScryptParams; key: string } | null = null;
  private pendingHello: Extract<RelayPayload, { k: 'auth.hello' }> | null = null;
  private iceServers: IceServer[] = [];
  private pc: RTCPeerConnection | null = null;
  private control: RTCDataChannel | null = null;
  private motion: RTCDataChannel | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private micTrack: MediaStreamTrack | null = null;
  private offSig: (() => void) | null = null;
  private statsTimer: number | null = null;
  private statsTracker = new InboundStatsTracker();
  private lastStats: InboundSummary | null = null;
  private seq = 1;
  private ended = false;
  private disconnectTimer: number | null = null;
  readonly startedAt = Date.now();
  connectedAt: number | null = null;

  constructor(
    private readonly sig: ClientSignaling,
    private readonly identity: Identity,
  ) {
    super();
  }

  nextSeq(): number {
    return this.seq++;
  }

  private setPhase(p: Phase): void {
    if (this.phase === p) return;
    this.phase = p;
    this.emit('phase', p);
  }

  async start(hostId: string): Promise<void> {
    this.hostId = hostId;
    this.setPhase('signaling');
    this.offSig = this.sig.on('message', (m) => this.onSignal(m));
    try {
      await this.sig.open();
    } catch {
      return this.end('Não foi possível conectar ao servidor RemoteX. Verifique a internet e o endereço do servidor.', true);
    }
    this.setPhase('requesting');
    this.sig.send({ t: 'connect', reqId: this.reqId, hostId, clientNonce: this.clientNonce });
  }

  private relay(payload: RelayPayload): void {
    this.sig.send({ t: 'relay', sessionId: this.sessionId, payload });
  }

  private onSignal(m: ServerToClient): void {
    if (this.ended) return;
    switch (m.t) {
      case 'error':
        if (m.reqId === this.reqId || (m.sessionId && m.sessionId === this.sessionId)) this.end(m.message, true);
        return;
      case 'session.created':
        if (m.reqId !== this.reqId) return;
        this.sessionId = m.sessionId;
        this.hostName = m.host.name;
        this.iceServers = m.iceServers;
        return;
      case 'relay':
        if (m.sessionId === this.sessionId) void this.onRelay(m.payload).catch((err) => this.end(`Erro: ${err?.message || err}`, true));
        return;
      case 'session.ended':
        if (m.sessionId === this.sessionId) this.end(endReasonText(m.reason), m.reason !== 'user' && m.reason !== 'host-ended');
        return;
    }
  }

  private sign(): string {
    return signMessage(this.identity.secretKey, clientIdentityMessage(this.sessionId, this.hostId, this.identity.deviceId, this.hostNonce, this.clientNonce));
  }

  private async onRelay(p: RelayPayload): Promise<void> {
    switch (p.k) {
      case 'auth.hello':
        return this.onAuthHello(p);
      case 'auth.pending':
        return this.setPhase('waiting-approval');
      case 'auth.result':
        return this.onAuthResult(p);
      case 'sdp':
        if (p.type === 'offer') return this.onOffer(p.sdp);
        return;
      case 'ice':
        if (!p.candidate) return;
        if (!this.pc?.remoteDescription) this.pendingIce.push(p.candidate);
        else await this.pc.addIceCandidate(p.candidate).catch(() => undefined);
        return;
      case 'bye':
        return this.end(p.reason || 'O computador encerrou a sessão', false);
    }
  }

  private onAuthHello(p: Extract<RelayPayload, { k: 'auth.hello' }>): void {
    const msg = hostIdentityMessage(this.sessionId, this.hostId, this.clientNonce, p.hostNonce);
    if (!verifySignature(p.hostPublicKey, msg, p.hostSignature)) {
      return this.end('A identidade do computador não pôde ser verificada. Conexão bloqueada por segurança.', true);
    }
    this.hostNonce = p.hostNonce;
    this.hostPublicKey = p.hostPublicKey;
    this.hostName = p.hostName || this.hostName;
    this.methods = p.methods;
    this.passwordInfo = p.password ?? null;
    if (this.methods.length === 0) return this.end('Este computador não está aceitando conexões no momento.', true);
    const pin = store.pin(this.hostId);
    if (pin && pin.publicKey !== p.hostPublicKey) {
      this.pendingHello = p;
      this.emit('host-key-changed', { hostName: this.hostName, oldFingerprint: pin.fingerprint, newFingerprint: keyFingerprint(p.hostPublicKey) });
      return;
    }
    this.chooseAuth(p.lockedForMs);
  }

  /** O usuário confirmou que a mudança de identidade do computador é legítima (ex.: reinstalação). */
  acceptNewHostKey(): void {
    if (!this.pendingHello) return;
    store.removePin(this.hostId);
    store.forgetKey(this.hostId);
    const p = this.pendingHello;
    this.pendingHello = null;
    this.chooseAuth(p.lockedForMs);
  }

  private chooseAuth(lockedForMs?: number, error?: string): void {
    this.setPhase('auth');
    const pin = store.pin(this.hostId);
    if (!this.triedDevice && pin?.trustedUnattended && this.methods.includes('device')) {
      this.triedDevice = true;
      this.method = 'device';
      this.bindingKey = null;
      this.relay({ k: 'auth.device', clientPublicKey: this.identity.publicKey, clientSignature: this.sign(), clientName: deviceName() });
      return;
    }
    const saved = store.savedKey(this.hostId);
    if (!this.triedSavedKey && saved && this.passwordInfo && saved.salt === this.passwordInfo.salt && this.methods.includes('password')) {
      this.triedSavedKey = true;
      this.sendPasswordProof(saved.key);
      return;
    }
    const password = this.methods.includes('password');
    const approval = this.methods.includes('approval');
    if (!password && approval && !error) return this.requestApproval();
    this.emit('auth-needed', { hostName: this.hostName, password, approval, error, lockedForMs });
  }

  async submitPassword(password: string, remember: boolean): Promise<void> {
    if (!this.passwordInfo || !isAcceptableScrypt(this.passwordInfo.params)) return this.end('Parâmetros de senha inválidos enviados pelo computador.', true);
    this.setPhase('auth');
    const key = await deriveAccessKey(password, this.passwordInfo.salt, this.passwordInfo.params);
    const keyHex = toHex(key);
    this.rememberKey = remember ? { salt: this.passwordInfo.salt, params: this.passwordInfo.params, key: keyHex } : null;
    this.sendPasswordProof(keyHex);
  }

  private sendPasswordProof(keyHex: string): void {
    this.bindingKey = keyHex;
    const ctx = { sessionId: this.sessionId, hostId: this.hostId, clientDeviceId: this.identity.deviceId, hostNonce: this.hostNonce, clientNonce: this.clientNonce };
    const proof = computeAuthProof(hexToBytes(keyHex), ctx);
    this.method = 'password';
    this.relay({ k: 'auth.password', proof, clientPublicKey: this.identity.publicKey, clientSignature: this.sign(), clientName: deviceName() });
  }

  requestApproval(): void {
    this.method = 'approval';
    this.bindingKey = null;
    this.setPhase('waiting-approval');
    this.relay({ k: 'auth.approval', clientPublicKey: this.identity.publicKey, clientSignature: this.sign(), clientName: deviceName() });
  }

  private onAuthResult(p: Extract<RelayPayload, { k: 'auth.result' }>): void {
    if (p.ok) {
      this.permissions = p.permissions ?? null;
      const prevPin = store.pin(this.hostId);
      store.savePin({
        hostId: this.hostId,
        publicKey: this.hostPublicKey,
        fingerprint: keyFingerprint(this.hostPublicKey),
        trustedUnattended: Boolean(p.trusted),
        pinnedAt: prevPin?.pinnedAt ?? new Date().toISOString(),
      });
      if (this.rememberKey) store.saveKey({ hostId: this.hostId, ...this.rememberKey });
      this.setPhase('connecting');
      return;
    }
    if (p.code === 'METHOD_UNAVAILABLE' && this.triedDevice && p.retry) {
      const pin = store.pin(this.hostId);
      if (pin) store.savePin({ ...pin, trustedUnattended: false });
      return this.chooseAuth();
    }
    if (p.code === 'BAD_PASSWORD' && this.triedSavedKey && !this.rememberKey) {
      store.forgetKey(this.hostId);
    }
    if (p.retry) return this.chooseAuth(undefined, p.reason || 'Tente novamente');
    this.end(p.reason || 'Acesso negado', true);
  }

  private async onOffer(sdp: string): Promise<void> {
    if (this.phase !== 'connecting' && this.phase !== 'auth' && this.phase !== 'waiting-approval') return;
    this.setPhase('connecting');
    const pc = new RTCPeerConnection({ iceServers: this.iceServers as RTCIceServer[], bundlePolicy: 'max-bundle' });
    this.pc = pc;
    pc.onicecandidate = (e) => this.relay({ k: 'ice', candidate: e.candidate ? (e.candidate.toJSON() as any) : null });
    pc.ontrack = (e) => {
      const s = e.streams[0] ?? this.stream ?? new MediaStream();
      if (!e.streams[0]) s.addTrack(e.track);
      if (this.stream !== s) {
        this.stream = s;
        this.emit('stream', s);
      }
    };
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      if (ch.label === CONTROL_CHANNEL) {
        this.control = ch;
        ch.onmessage = (ev) => this.onControlMessage(ev.data);
        ch.onopen = () => this.sendControl({ k: 'hello', viewport: { w: screen.width, h: screen.height, dpr: devicePixelRatio }, app: 'remotex-mobile' });
        ch.onclose = () => this.end('Canal de controle encerrado', true);
      } else if (ch.label === MOTION_CHANNEL) {
        this.motion = ch;
        ch.onmessage = (ev) => {
          try {
            const m = JSON.parse(ev.data) as MotionMessage;
            if (m.k === 'cur') this.emit('cursor', { x: m.x, y: m.y });
          } catch {
            /* ignora */
          }
        };
      }
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'connected' && this.disconnectTimer) {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
      }
      if (st === 'disconnected') this.disconnectTimer ??= window.setTimeout(() => this.end('Conexão perdida', true), 12_000);
      if (st === 'failed') this.end('Falha na conexão de rede com o computador', true);
    };
    await pc.setRemoteDescription({ type: 'offer', sdp });
    for (const t of pc.getTransceivers()) {
      if (t.receiver.track?.kind === 'audio') t.direction = 'sendrecv';
    }
    for (const c of this.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.relay({ k: 'sdp', type: 'answer', sdp: pc.localDescription!.sdp });
    this.statsTimer = window.setInterval(() => void this.pollStats(), 1000);
  }

  private onControlMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let m: HostControlMessage;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.k === 'welcome') return this.onWelcome(m as Welcome);
    if (m.k === 'bind.result') {
      if (!m.ok) return this.end('O computador recusou a verificação de segurança do canal.', true);
      this.connectedAt = Date.now();
      this.setPhase('connected');
      this.emit('verified', { sas: this.sas });
      return;
    }
    if (m.k === 'perms') this.permissions = m.permissions;
    if (m.k === 'bye') return this.end(m.reason || 'O computador encerrou a sessão', false);
    this.emit('control', m);
  }

  private onWelcome(w: Welcome): void {
    const pc = this.pc!;
    const hostFp = extractDtlsFingerprint(pc.remoteDescription?.sdp);
    const clientFp = extractDtlsFingerprint(pc.localDescription?.sdp);
    if (!hostFp || !clientFp) return this.end('Não foi possível verificar o canal seguro.', true);
    const msg = bindingMessage(this.sessionId, hostFp, clientFp);
    if (!w.hostBind || !verifySignature(this.hostPublicKey, msg, w.hostBind)) {
      return this.end('Falha na verificação de segurança: o canal pode estar sendo interceptado. Conexão encerrada.', true);
    }
    this.sas = sessionVerificationCode(hostFp, clientFp);
    if (w.sas && w.sas !== this.sas) return this.end('Os códigos de verificação não conferem. Conexão encerrada.', true);
    this.welcome = w;
    this.permissions = w.permissions;
    this.emit('welcome', w);
    this.setPhase('verifying');
    const proof = this.method === 'password' && this.bindingKey ? hmacHex(this.bindingKey, msg) : signMessage(this.identity.secretKey, msg);
    this.sendControl({ k: 'bind', proof });
  }

  sendControl(m: ClientControlMessage): void {
    if (this.control?.readyState === 'open') this.control.send(JSON.stringify(m));
  }

  sendMotion(m: MotionMessage): void {
    if (this.motion?.readyState === 'open') this.motion.send(JSON.stringify(m));
    else this.sendControl(m as any);
  }

  get stats(): InboundSummary | null {
    return this.lastStats;
  }

  private async pollStats(): Promise<void> {
    if (!this.pc || this.pc.connectionState !== 'connected') return;
    const s = this.statsTracker.summarize(await this.pc.getStats());
    if (!s) return;
    this.lastStats = s;
    this.emit('stats', s);
    if (Math.round(Date.now() / 1000) % 5 === 0) {
      this.sendControl({ k: 'cstats', fps: s.fps, rtt: s.rttMs ?? 0, loss: s.lossPct, jitter: s.jitterMs, decodeMs: s.decodeMs, w: s.width, h: s.height });
    }
  }

  /** Liga/desliga o microfone do celular (transmitido ao computador, se permitido). */
  async setMic(on: boolean): Promise<boolean> {
    const t = this.pc?.getTransceivers().find((x) => x.receiver.track?.kind === 'audio');
    if (!t) return false;
    if (on) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
        this.micTrack = s.getAudioTracks()[0];
        await t.sender.replaceTrack(this.micTrack);
      } catch {
        return false;
      }
    } else {
      await t.sender.replaceTrack(null);
      this.micTrack?.stop();
      this.micTrack = null;
    }
    this.sendControl({ k: 'mic', enabled: on });
    return true;
  }

  disconnect(reason = 'Você encerrou a sessão'): void {
    if (this.ended) return;
    this.sendControl({ k: 'release' });
    this.sendControl({ k: 'bye', reason: 'user' });
    if (this.sessionId) {
      this.relay({ k: 'bye', reason: 'user' });
      this.sig.send({ t: 'session.end', sessionId: this.sessionId, reason: 'user' });
    }
    this.end(reason, false);
  }

  private end(reason: string, error: boolean): void {
    if (this.ended) return;
    this.ended = true;
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.micTrack?.stop();
    try {
      this.pc?.close();
    } catch {
      /* já fechado */
    }
    this.offSig?.();
    if (this.sessionId && this.phase !== 'connected') this.sig.send({ t: 'session.end', sessionId: this.sessionId, reason: 'cancelled' });
    this.setPhase('ended');
    this.emit('ended', { reason, error });
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function deviceName(): string {
  return store.settings().deviceName;
}

function endReasonText(reason: string): string {
  const map: Record<string, string> = {
    'peer-disconnected': 'O computador ficou offline',
    'peer-offline': 'O computador ficou offline',
    timeout: 'Tempo esgotado aguardando o computador',
    rejected: 'Acesso recusado',
    disabled: 'Conexões remotas desativadas no computador',
    busy: 'O computador já está em outra sessão',
    'host-ended': 'O computador encerrou a sessão',
    user: 'Sessão encerrada',
  };
  return map[reason] || `Sessão encerrada (${reason})`;
}
