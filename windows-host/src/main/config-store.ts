/**
 * Configuração persistente do HOST (JSON em %APPDATA%/RemoteX Host/config.json).
 * Segredos (token do dispositivo, chave privada do host, verificador da senha) são cifrados com
 * safeStorage — no Windows isso usa DPAPI, vinculando os dados ao usuário do Windows.
 */
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { PasswordVerifier } from '@remotex/auth/password';
import { DEFAULT_GRANT, DEFAULT_POLICY, sanitizePermissions, type PermissionSet } from '@remotex/security/permissions';
import type { AudioQuality, QualityPreset, RecordingQuality } from '@remotex/media/channel-protocol';
import type { VideoCodecPref } from '@remotex/media/codecs';

export interface TrustedDevice {
  deviceId: string;
  name: string;
  publicKey: string;
  fingerprint: string;
  permissions: PermissionSet;
  unattended: boolean;
  addedAt: string;
  lastSeenAt: string | null;
}

export interface HistoryEntry {
  sessionId: string;
  clientId: string;
  clientName: string;
  clientFingerprint: string;
  ip: string | null;
  method: string | null;
  result: 'connected' | 'rejected' | 'failed' | 'timeout' | 'cancelled';
  reason?: string;
  requestedAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface HostConfig {
  serverUrl: string;
  deviceId: string | null;
  deviceToken: string | null;
  registeredServer: string | null;
  deviceName: string;
  hostKey: { publicKey: string; secretKey: string } | null;
  incomingEnabled: boolean;
  attendedEnabled: boolean;
  unattendedEnabled: boolean;
  password: PasswordVerifier | null;
  passwordPermissions: PermissionSet;
  policy: PermissionSet;
  trusted: TrustedDevice[];
  quality: { preset: QualityPreset; codec: VideoCodecPref };
  audio: { quality: AudioQuality; enabledByDefault: boolean };
  recording: { dir: string | null; quality: RecordingQuality };
  launchAtStartup: boolean;
  runInBackground: boolean;
  approvalTimeoutSec: number;
  history: HistoryEntry[];
}

const SECRET_FIELDS = ['deviceToken'] as const;

function defaults(): HostConfig {
  return {
    serverUrl: process.env.REMOTEX_SERVER || 'http://127.0.0.1:8080',
    deviceId: null,
    deviceToken: null,
    registeredServer: null,
    deviceName: process.env.COMPUTERNAME || process.env.HOSTNAME || 'Meu computador',
    hostKey: null,
    incomingEnabled: true,
    attendedEnabled: true,
    unattendedEnabled: false,
    password: null,
    passwordPermissions: { ...DEFAULT_GRANT },
    policy: { ...DEFAULT_POLICY },
    trusted: [],
    quality: { preset: 'auto', codec: 'auto' },
    audio: { quality: 'medium', enabledByDefault: false },
    recording: { dir: null, quality: 'medium' },
    launchAtStartup: false,
    runInBackground: false,
    approvalTimeoutSec: 60,
    history: [],
  };
}

function seal(value: string): string {
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(value).toString('base64');
  return 'plain:' + value;
}

function unseal(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    } catch {
      console.error('[config] não foi possível decifrar um segredo (perfil do Windows diferente?)');
      return null;
    }
  }
  if (value.startsWith('plain:')) return value.slice(6);
  return null;
}

export class ConfigStore {
  readonly file: string;
  private data: HostConfig;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dir = app.getPath('userData')) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'config.json');
    this.data = this.load();
  }

  get(): HostConfig {
    return this.data;
  }

  update(mut: (c: HostConfig) => void): HostConfig {
    mut(this.data);
    this.scheduleSave();
    return this.data;
  }

  addHistory(e: HistoryEntry): void {
    this.update((c) => {
      const i = c.history.findIndex((h) => h.sessionId === e.sessionId);
      if (i >= 0) c.history[i] = e;
      else c.history.unshift(e);
      c.history = c.history.slice(0, 500);
    });
  }

  private load(): HostConfig {
    const base = defaults();
    if (!fs.existsSync(this.file)) return base;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const merged: HostConfig = { ...base, ...raw };
      for (const f of SECRET_FIELDS) merged[f] = unseal(raw[f]);
      merged.hostKey = raw.hostKey ? { publicKey: raw.hostKey.publicKey, secretKey: unseal(raw.hostKey.secretKey) || '' } : null;
      if (merged.hostKey && !merged.hostKey.secretKey) merged.hostKey = null;
      merged.password = raw.password ? { ...raw.password, key: unseal(raw.password.key) || '' } : null;
      if (merged.password && !merged.password.key) merged.password = null;
      merged.policy = sanitizePermissions(merged.policy);
      merged.passwordPermissions = sanitizePermissions(merged.passwordPermissions);
      merged.trusted = (merged.trusted || []).map((t) => ({ ...t, permissions: sanitizePermissions(t.permissions) }));
      merged.quality = { ...base.quality, ...(raw.quality || {}) };
      merged.audio = { ...base.audio, ...(raw.audio || {}) };
      merged.recording = { ...base.recording, ...(raw.recording || {}) };
      return merged;
    } catch (err) {
      console.error('[config] arquivo de configuração inválido; usando padrões', err);
      return base;
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 150);
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const c = this.data;
    const out: Record<string, unknown> = { ...c };
    for (const f of SECRET_FIELDS) out[f] = c[f] ? seal(c[f] as string) : null;
    out.hostKey = c.hostKey ? { publicKey: c.hostKey.publicKey, secretKey: seal(c.hostKey.secretKey) } : null;
    out.password = c.password ? { ...c.password, key: seal(c.password.key) } : null;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
