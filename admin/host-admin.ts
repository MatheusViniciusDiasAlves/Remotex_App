/**
 * Painel administrativo remoto: chamadas RPC que um celular com permissão "admin" pode fazer ao
 * computador durante a sessão (pelo canal de dados criptografado). Também usado pelo painel
 * local do host. Toda alteração é registrada pelo chamador no log local.
 */
import { sanitizePermissions, type PermissionSet } from '@remotex/security/permissions';

export interface TrustedView {
  deviceId: string;
  name: string;
  fingerprint: string;
  permissions: PermissionSet;
  unattended: boolean;
  addedAt: string;
  lastSeenAt: string | null;
}

export interface AdminHost {
  overview(): Record<string, unknown>;
  listTrusted(): TrustedView[];
  updateTrusted(deviceId: string, patch: { permissions?: PermissionSet; unattended?: boolean; name?: string }): boolean;
  revokeTrusted(deviceId: string): boolean;
  history(limit: number): unknown[];
  setIncoming(enabled: boolean): void;
  setAttended(enabled: boolean): void;
  setUnattended(enabled: boolean): void;
  setPolicy(policy: PermissionSet): void;
  listRecordings(): Promise<Array<{ name: string; size: number; createdAt: string }>>;
  requestElevation(): Promise<{ ok: boolean; message: string }>;
}

export class AdminError extends Error {}

export const ADMIN_METHODS = [
  'admin.overview',
  'admin.listTrusted',
  'admin.updateTrusted',
  'admin.revokeTrusted',
  'admin.history',
  'admin.setIncoming',
  'admin.setAttended',
  'admin.setUnattended',
  'admin.setPolicy',
  'admin.listRecordings',
  'system.requestElevation',
] as const;

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new AdminError(`Parâmetro inválido: ${name}`);
  return v;
}

function bool(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') throw new AdminError(`Parâmetro inválido: ${name}`);
  return v;
}

export async function handleAdminRpc(
  host: AdminHost,
  perms: PermissionSet,
  method: string,
  params: Record<string, unknown> = {},
  selfDeviceId?: string,
): Promise<unknown> {
  if (!perms.admin) throw new AdminError('Este dispositivo não tem permissão de administração');
  switch (method) {
    case 'admin.overview':
      return host.overview();
    case 'admin.listTrusted':
      return host.listTrusted();
    case 'admin.updateTrusted': {
      const id = str(params.deviceId, 'deviceId');
      const patch: { permissions?: PermissionSet; unattended?: boolean; name?: string } = {};
      if (params.permissions !== undefined) patch.permissions = sanitizePermissions(params.permissions);
      if (params.unattended !== undefined) patch.unattended = bool(params.unattended, 'unattended');
      if (params.name !== undefined) patch.name = str(params.name, 'name').slice(0, 64);
      if (id === selfDeviceId && patch.permissions && !patch.permissions.admin) {
        throw new AdminError('Para evitar perder o acesso, remova a permissão de administração deste aparelho pelo próprio computador');
      }
      if (!host.updateTrusted(id, patch)) throw new AdminError('Dispositivo não encontrado');
      return { ok: true };
    }
    case 'admin.revokeTrusted': {
      const id = str(params.deviceId, 'deviceId');
      if (!host.revokeTrusted(id)) throw new AdminError('Dispositivo não encontrado');
      return { ok: true };
    }
    case 'admin.history':
      return host.history(Math.min(200, Math.max(1, Number(params.limit) || 50)));
    case 'admin.setIncoming':
      host.setIncoming(bool(params.enabled, 'enabled'));
      return { ok: true };
    case 'admin.setAttended':
      host.setAttended(bool(params.enabled, 'enabled'));
      return { ok: true };
    case 'admin.setUnattended':
      host.setUnattended(bool(params.enabled, 'enabled'));
      return { ok: true };
    case 'admin.setPolicy':
      host.setPolicy(sanitizePermissions(params.policy));
      return { ok: true };
    case 'admin.listRecordings':
      return host.listRecordings();
    case 'system.requestElevation':
      return host.requestElevation();
    default:
      throw new AdminError(`Método desconhecido: ${method}`);
  }
}
