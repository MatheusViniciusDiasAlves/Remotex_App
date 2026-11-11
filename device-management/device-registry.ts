/**
 * Registro de dispositivos (computadores HOST e celulares CLIENTE) no PostgreSQL.
 * Cada dispositivo recebe um ID RemoteX de 9 dígitos e um token secreto (guardado apenas como
 * hash SHA-256 no servidor) usado para autenticar a conexão de sinalização e a API.
 */
import type { Database } from '@remotex/database/db';
import { generateDeviceId, isValidDeviceId, randomToken } from '@remotex/shared/ids';
import { hashToken, tokensEqual } from '@remotex/auth/account-password';

export type DeviceKind = 'host' | 'client';

export interface DeviceRecord {
  id: string;
  kind: DeviceKind;
  name: string;
  platform: string;
  appVersion: string;
  ownerId: string | null;
  ownerEmail: string | null;
  publicKey: string | null;
  revoked: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  lastIp: string | null;
}

function mapRow(r: any): DeviceRecord {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    platform: r.platform,
    appVersion: r.app_version,
    ownerId: r.owner_id,
    ownerEmail: r.owner_email ?? null,
    publicKey: r.public_key,
    revoked: r.revoked,
    createdAt: new Date(r.created_at).toISOString(),
    lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
    lastIp: r.last_ip,
  };
}

const SELECT = `SELECT d.*, u.email AS owner_email FROM devices d LEFT JOIN users u ON u.id = d.owner_id`;

export class DeviceRegistry {
  constructor(private readonly db: Database) {}

  async register(input: {
    kind: DeviceKind;
    name: string;
    platform: string;
    appVersion: string;
    publicKey?: string | null;
    ownerId?: string | null;
    ip?: string | null;
  }): Promise<{ device: DeviceRecord; token: string }> {
    const token = randomToken(32);
    const tokenHash = hashToken(token);
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = generateDeviceId();
      try {
        await this.db.query(
          `INSERT INTO devices (id, kind, name, platform, app_version, owner_id, token_hash, public_key, last_ip)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, input.kind, input.name, input.platform, input.appVersion, input.ownerId ?? null, tokenHash, input.publicKey ?? null, input.ip ?? null],
        );
        const device = (await this.get(id))!;
        return { device, token };
      } catch (err: any) {
        if (err?.code === '23505') continue; // colisão de ID: tenta outro
        throw err;
      }
    }
    throw new Error('Não foi possível gerar um ID único');
  }

  async get(id: string): Promise<DeviceRecord | null> {
    if (!isValidDeviceId(id)) return null;
    const r = await this.db.one(`${SELECT} WHERE d.id = $1`, [id]);
    return r ? mapRow(r) : null;
  }

  /** Valida o token do dispositivo. Retorna 'revoked' se o dispositivo foi revogado. */
  async authenticate(id: string, token: string): Promise<DeviceRecord | 'revoked' | null> {
    if (!isValidDeviceId(id) || typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
    const r = await this.db.one(`${SELECT} WHERE d.id = $1`, [id]);
    if (!r || !tokensEqual(r.token_hash, hashToken(token))) return null;
    if (r.revoked) return 'revoked';
    return mapRow(r);
  }

  async touch(id: string, ip: string | null): Promise<void> {
    await this.db.query('UPDATE devices SET last_seen_at = now(), last_ip = COALESCE($2, last_ip) WHERE id = $1', [id, ip]);
  }

  async update(id: string, patch: { name?: string; publicKey?: string | null; platform?: string; appVersion?: string }): Promise<DeviceRecord | null> {
    await this.db.query(
      `UPDATE devices SET
         name = COALESCE($2, name),
         public_key = COALESCE($3, public_key),
         platform = COALESCE($4, platform),
         app_version = COALESCE($5, app_version)
       WHERE id = $1`,
      [id, patch.name ?? null, patch.publicKey ?? null, patch.platform ?? null, patch.appVersion ?? null],
    );
    return this.get(id);
  }

  async listByOwner(ownerId: string): Promise<DeviceRecord[]> {
    const r = await this.db.query(`${SELECT} WHERE d.owner_id = $1 AND NOT d.revoked ORDER BY d.kind, d.name`, [ownerId]);
    return r.rows.map(mapRow);
  }

  async claim(id: string, token: string, ownerId: string): Promise<DeviceRecord | null> {
    const dev = await this.authenticate(id, token);
    if (!dev || dev === 'revoked') return null;
    await this.db.query('UPDATE devices SET owner_id = $2 WHERE id = $1', [id, ownerId]);
    return this.get(id);
  }

  async revoke(id: string): Promise<void> {
    await this.db.query('UPDATE devices SET revoked = true WHERE id = $1', [id]);
  }

  async countByKind(): Promise<Record<string, number>> {
    const r = await this.db.query<{ kind: string; n: string }>('SELECT kind, count(*) AS n FROM devices WHERE NOT revoked GROUP BY kind');
    return Object.fromEntries(r.rows.map((x) => [x.kind, Number(x.n)]));
  }
}
