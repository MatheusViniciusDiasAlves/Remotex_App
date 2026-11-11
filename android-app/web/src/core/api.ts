/** Cliente da API REST do servidor RemoteX (registro do celular, conta, dispositivos, histórico). */
import { generateDeviceKeyPair } from '@remotex/auth/device-keys';
import { APP_VERSION } from '@remotex/shared/version';
import { store, type Identity } from './storage';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function base(): string {
  return store.settings().serverUrl.replace(/\/+$/, '');
}

async function request<T = any>(method: string, path: string, body?: unknown, auth?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base() + path, {
      method,
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', `Sem conexão com o servidor ${base()}`);
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || 'HTTP', data?.message || `Erro ${res.status}`);
  return data as T;
}

/** Garante que este celular está registrado no servidor atual (gera ID e chave Ed25519). */
export async function ensureIdentity(): Promise<Identity> {
  const s = store.settings();
  const current = store.identity();
  if (current && current.serverUrl === s.serverUrl) return current;
  const keys = current?.secretKey ? { publicKey: current.publicKey, secretKey: current.secretKey } : generateDeviceKeyPair();
  const account = store.account();
  const r = await request<{ deviceId: string; token: string }>(
    'POST',
    '/api/devices/register',
    { kind: 'client', name: s.deviceName, platform: (window as any).RemoteXNative ? 'android' : 'web', appVersion: APP_VERSION, publicKey: keys.publicKey },
    account ? `Bearer ${account.accessToken}` : undefined,
  );
  const id: Identity = { serverUrl: s.serverUrl, deviceId: r.deviceId, token: r.token, ...keys };
  store.saveIdentity(id);
  return id;
}

function deviceAuth(): string {
  const id = store.identity();
  if (!id) throw new ApiError(401, 'NO_IDENTITY', 'Dispositivo não registrado');
  return `Device ${id.deviceId}:${id.token}`;
}

/** Requisição autenticada pela conta, com renovação automática do token de acesso. */
async function withAccount<T>(method: string, path: string, body?: unknown): Promise<T> {
  const acc = store.account();
  if (!acc) throw new ApiError(401, 'NO_ACCOUNT', 'Entre na sua conta');
  try {
    return await request<T>(method, path, body, `Bearer ${acc.accessToken}`);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err;
    const r = await request<any>('POST', '/api/auth/refresh', { refreshToken: acc.refreshToken }).catch((e) => {
      store.saveAccount(null);
      throw e;
    });
    store.saveAccount({ accessToken: r.accessToken, refreshToken: r.refreshToken, email: r.user.email, name: r.user.name, role: r.user.role });
    return request<T>(method, path, body, `Bearer ${r.accessToken}`);
  }
}

export const api = {
  health: () => request<{ ok: boolean; version: string }>('GET', '/api/health'),
  updateDevice: (patch: { name?: string }) => request('PATCH', '/api/devices/me', patch, deviceAuth()),
  presence: (ids: string[]) => request<{ statuses: Record<string, boolean> }>('GET', `/api/devices/status?ids=${ids.join(',')}`),
  mySessions: () => request<{ sessions: any[] }>('GET', '/api/devices/me/sessions', undefined, deviceAuth()),
  async login(email: string, password: string) {
    const r = await request<any>('POST', '/api/auth/login', { email, password });
    store.saveAccount({ accessToken: r.accessToken, refreshToken: r.refreshToken, email: r.user.email, name: r.user.name, role: r.user.role });
    return r.user;
  },
  async register(email: string, name: string, password: string) {
    const r = await request<any>('POST', '/api/auth/register', { email, name, password });
    store.saveAccount({ accessToken: r.accessToken, refreshToken: r.refreshToken, email: r.user.email, name: r.user.name, role: r.user.role });
    return r.user;
  },
  async logout() {
    const acc = store.account();
    if (acc) await request('POST', '/api/auth/logout', { refreshToken: acc.refreshToken }).catch(() => undefined);
    store.saveAccount(null);
  },
  claimThisDevice() {
    const id = store.identity();
    if (!id) throw new ApiError(401, 'NO_IDENTITY', 'Dispositivo não registrado');
    return withAccount('POST', '/api/devices/claim', { deviceId: id.deviceId, token: id.token });
  },
  myDevices: () => withAccount<{ devices: any[] }>('GET', '/api/devices'),
  renameDevice: (id: string, name: string) => withAccount('PATCH', `/api/devices/${id}`, { name }),
  revokeDevice: (id: string) => withAccount('DELETE', `/api/devices/${id}`),
  accountSessions: () => withAccount<{ sessions: any[] }>('GET', '/api/sessions'),
  adminUsers: () => withAccount<{ users: any[] }>('GET', '/api/admin/users'),
  adminUpdateUser: (id: string, patch: { disabled?: boolean; role?: string }) => withAccount('PATCH', `/api/admin/users/${id}`, patch),
};
