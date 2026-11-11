/**
 * Armazenamento local do aplicativo (celular): identidade do dispositivo, configurações,
 * computadores favoritos, chaves de computadores fixadas (TOFU), senhas lembradas (apenas a
 * chave derivada, nunca a senha) e histórico. No app Android, o WebView guarda estes dados no
 * armazenamento privado do aplicativo.
 */
import type { ScryptParams } from '@remotex/auth/password';
import type { AudioQuality, QualityPreset, RecordingQuality } from '@remotex/media/channel-protocol';

export type ControlMode = 'touch' | 'mouse';
export type ViewMode = 'fit' | 'original';

export interface Settings {
  serverUrl: string;
  deviceName: string;
  controlMode: ControlMode;
  viewMode: ViewMode;
  quality: QualityPreset;
  autoKeyboard: boolean;
  haptics: boolean;
  invertScroll: boolean;
  sensitivity: number;
  showLocalCursor: boolean;
  keepScreenOn: boolean;
  audioOnConnect: boolean;
  audioQuality: AudioQuality;
  recordingQuality: RecordingQuality;
  orientation: 'auto' | 'landscape' | 'portrait';
}

export interface Identity {
  serverUrl: string;
  deviceId: string;
  token: string;
  publicKey: string;
  secretKey: string;
}

export interface Favorite {
  hostId: string;
  name: string;
  lastConnectedAt: string | null;
  addedAt: string;
}

export interface HostPin {
  hostId: string;
  publicKey: string;
  fingerprint: string;
  trustedUnattended: boolean;
  pinnedAt: string;
}

export interface SavedKey {
  hostId: string;
  salt: string;
  params: ScryptParams;
  key: string;
}

export interface LocalHistoryEntry {
  id: string;
  hostId: string;
  hostName: string;
  method: string | null;
  result: 'connected' | 'failed' | 'rejected' | 'cancelled';
  reason?: string;
  startedAt: string;
  endedAt: string | null;
}

export interface RecordingMeta {
  name: string;
  size: number;
  createdAt: string;
  location: string;
}

const PREFIX = 'remotex.';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? { ...(fallback as any), ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function readList<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* armazenamento indisponível (modo privado) */
  }
}

function defaultServer(): string {
  const injected = (window as any).REMOTEX_DEFAULT_SERVER as string | undefined;
  if (injected) return injected;
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    if (!/appassets\.androidplatform\.net$/.test(location.hostname)) return location.origin;
  }
  return 'https://remotex.example.com';
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: '',
  deviceName: '',
  controlMode: 'touch',
  viewMode: 'fit',
  quality: 'auto',
  autoKeyboard: true,
  haptics: true,
  invertScroll: false,
  sensitivity: 1,
  showLocalCursor: true,
  keepScreenOn: true,
  audioOnConnect: false,
  audioQuality: 'medium',
  recordingQuality: 'medium',
  orientation: 'auto',
};

export const store = {
  settings(): Settings {
    const s = read<Settings>('settings', { ...DEFAULT_SETTINGS });
    if (!s.serverUrl) s.serverUrl = defaultServer();
    if (!s.deviceName) s.deviceName = guessDeviceName();
    return s;
  },
  saveSettings(patch: Partial<Settings>): Settings {
    const s = { ...store.settings(), ...patch };
    write('settings', s);
    return s;
  },
  identity(): Identity | null {
    const id = read<Identity | null>('identity', null);
    return id && id.deviceId && id.token && id.secretKey ? id : null;
  },
  saveIdentity(id: Identity | null): void {
    if (id) write('identity', id);
    else localStorage.removeItem(PREFIX + 'identity');
  },
  favorites(): Favorite[] {
    return readList<Favorite>('favorites');
  },
  saveFavorite(f: Favorite): void {
    const list = store.favorites().filter((x) => x.hostId !== f.hostId);
    list.unshift(f);
    write('favorites', list.slice(0, 100));
  },
  removeFavorite(hostId: string): void {
    write('favorites', store.favorites().filter((x) => x.hostId !== hostId));
  },
  pins(): HostPin[] {
    return readList<HostPin>('pins');
  },
  pin(hostId: string): HostPin | undefined {
    return store.pins().find((p) => p.hostId === hostId);
  },
  savePin(p: HostPin): void {
    write('pins', [p, ...store.pins().filter((x) => x.hostId !== p.hostId)]);
  },
  removePin(hostId: string): void {
    write('pins', store.pins().filter((x) => x.hostId !== hostId));
  },
  savedKey(hostId: string): SavedKey | undefined {
    return readList<SavedKey>('keys').find((k) => k.hostId === hostId);
  },
  saveKey(k: SavedKey): void {
    write('keys', [k, ...readList<SavedKey>('keys').filter((x) => x.hostId !== k.hostId)]);
  },
  forgetKey(hostId: string): void {
    write('keys', readList<SavedKey>('keys').filter((x) => x.hostId !== hostId));
  },
  history(): LocalHistoryEntry[] {
    return readList<LocalHistoryEntry>('history');
  },
  saveHistory(e: LocalHistoryEntry): void {
    const list = store.history().filter((x) => x.id !== e.id);
    list.unshift(e);
    write('history', list.slice(0, 300));
  },
  clearHistory(): void {
    write('history', []);
  },
  recordings(): RecordingMeta[] {
    return readList<RecordingMeta>('recordings');
  },
  addRecording(r: RecordingMeta): void {
    write('recordings', [r, ...store.recordings()].slice(0, 200));
  },
  account(): { accessToken: string; refreshToken: string; email: string; name: string; role: string } | null {
    return read('account', null as any);
  },
  saveAccount(a: { accessToken: string; refreshToken: string; email: string; name: string; role: string } | null): void {
    if (a) write('account', a);
    else localStorage.removeItem(PREFIX + 'account');
  },
};

function guessDeviceName(): string {
  const native = (window as any).RemoteXNative?.deviceModel?.();
  if (native) return String(native);
  const ua = navigator.userAgent;
  const m = /Android [\d.]+; ([^;)]+)/.exec(ua);
  if (m) return m[1].replace(/ Build\/.*/, '').trim();
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  return 'Celular';
}
