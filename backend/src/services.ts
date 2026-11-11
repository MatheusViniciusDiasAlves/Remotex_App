/**
 * Serviços de domínio do backend: contas de usuário (com refresh tokens rotativos), histórico de
 * sessões e log de auditoria. O registro de dispositivos fica em device-management/.
 */
import type { Database } from '@remotex/database/db';
import { hashAccountPassword, hashToken, verifyAccountPassword } from '@remotex/auth/account-password';
import { JwtService } from '@remotex/auth/jwt';
import { randomToken, uuid } from '@remotex/shared/ids';

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

function mapUser(r: any): UserRecord {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    disabled: r.disabled,
    createdAt: new Date(r.created_at).toISOString(),
    lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
  };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;

export class AccountService {
  constructor(
    private readonly db: Database,
    readonly jwt: JwtService,
  ) {}

  async register(email: string, name: string, password: string): Promise<UserRecord> {
    const normalized = email.trim().toLowerCase();
    const exists = await this.db.one('SELECT 1 FROM users WHERE email = $1', [normalized]);
    if (exists) throw new HttpError(409, 'EMAIL_TAKEN', 'Este e-mail já está cadastrado');
    const hash = await hashAccountPassword(password);
    const id = uuid();
    // O primeiro usuário do servidor torna-se administrador.
    await this.db.tx(async (c) => {
      await c.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
      const count = Number((await c.query('SELECT count(*) AS n FROM users')).rows[0].n);
      await c.query('INSERT INTO users (id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,$5)', [
        id,
        normalized,
        name.trim(),
        hash,
        count === 0 ? 'admin' : 'user',
      ]);
    });
    return (await this.get(id))!;
  }

  async get(id: string): Promise<UserRecord | null> {
    const r = await this.db.one('SELECT * FROM users WHERE id = $1', [id]);
    return r ? mapUser(r) : null;
  }

  async login(email: string, password: string, userAgent: string | null) {
    const r = await this.db.one('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    // Executa o hash mesmo se o usuário não existir (evita enumeração por tempo de resposta).
    const ok = await verifyAccountPassword(password, r?.password_hash ?? 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    if (!r || !ok) throw new HttpError(401, 'BAD_CREDENTIALS', 'E-mail ou senha incorretos');
    if (r.disabled) throw new HttpError(403, 'DISABLED', 'Conta desativada pelo administrador');
    await this.db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [r.id]);
    return this.issueTokens(mapUser(r), userAgent);
  }

  async issueTokens(user: UserRecord, userAgent: string | null, replacing?: string) {
    const refreshToken = randomToken(32);
    const id = uuid();
    await this.db.query(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, user_agent) VALUES ($1,$2,$3,$4,$5)',
      [id, user.id, hashToken(refreshToken), new Date(Date.now() + REFRESH_TTL_MS), userAgent?.slice(0, 200) ?? null],
    );
    if (replacing) await this.db.query('UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1', [replacing, id]);
    const accessToken = await this.jwt.sign({ sub: user.id, role: user.role, email: user.email });
    return { accessToken, refreshToken, expiresIn: this.jwt.ttl, user };
  }

  /** Rotação de refresh token. Reuso de token já rotacionado revoga todas as sessões (roubo). */
  async refresh(refreshToken: string, userAgent: string | null) {
    const r = await this.db.one('SELECT * FROM refresh_tokens WHERE token_hash = $1', [hashToken(String(refreshToken))]);
    if (!r) throw new HttpError(401, 'BAD_REFRESH', 'Sessão expirada. Entre novamente.');
    if (r.revoked_at) {
      await this.db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [r.user_id]);
      throw new HttpError(401, 'REFRESH_REUSED', 'Sessão inválida. Entre novamente.');
    }
    if (new Date(r.expires_at).getTime() < Date.now()) throw new HttpError(401, 'BAD_REFRESH', 'Sessão expirada. Entre novamente.');
    const user = await this.get(r.user_id);
    if (!user || user.disabled) throw new HttpError(403, 'DISABLED', 'Conta desativada');
    return this.issueTokens(user, userAgent, r.id);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [hashToken(String(refreshToken))]);
  }

  async list(): Promise<UserRecord[]> {
    return (await this.db.query('SELECT * FROM users ORDER BY created_at')).rows.map(mapUser);
  }

  async update(id: string, patch: { disabled?: boolean; role?: 'user' | 'admin'; name?: string }): Promise<UserRecord | null> {
    await this.db.query(
      'UPDATE users SET disabled = COALESCE($2, disabled), role = COALESCE($3, role), name = COALESCE($4, name) WHERE id = $1',
      [id, patch.disabled ?? null, patch.role ?? null, patch.name ?? null],
    );
    if (patch.disabled) await this.db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    return this.get(id);
  }
}

export interface SessionRow {
  id: string;
  hostId: string;
  hostName: string;
  clientId: string;
  clientName: string;
  clientIp: string | null;
  status: string;
  authMethod: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  durationSec: number | null;
}

function mapSession(r: any): SessionRow {
  const started = r.started_at ? new Date(r.started_at) : null;
  const ended = r.ended_at ? new Date(r.ended_at) : null;
  return {
    id: r.id,
    hostId: r.host_id,
    hostName: r.host_name,
    clientId: r.client_id,
    clientName: r.client_name,
    clientIp: r.client_ip,
    status: r.status,
    authMethod: r.auth_method,
    createdAt: new Date(r.created_at).toISOString(),
    startedAt: started?.toISOString() ?? null,
    endedAt: ended?.toISOString() ?? null,
    endReason: r.end_reason,
    durationSec: started && ended ? Math.round((ended.getTime() - started.getTime()) / 1000) : null,
  };
}

const SESSION_SELECT = `SELECT s.*, h.name AS host_name, c.name AS client_name
  FROM sessions s JOIN devices h ON h.id = s.host_id JOIN devices c ON c.id = s.client_id`;

export class SessionHistory {
  constructor(private readonly db: Database) {}

  async create(s: { id: string; hostId: string; clientId: string; clientIp: string | null }): Promise<void> {
    await this.db.query('INSERT INTO sessions (id, host_id, client_id, client_ip, status) VALUES ($1,$2,$3,$4,$5)', [
      s.id,
      s.hostId,
      s.clientId,
      s.clientIp,
      'pending',
    ]);
  }

  async update(id: string, p: { status?: string; authMethod?: string | null; started?: boolean; ended?: boolean; endReason?: string | null }) {
    await this.db.query(
      `UPDATE sessions SET
        status = CASE WHEN $2::text IS NULL THEN status
                      WHEN status IN ('ended','rejected') THEN status
                      WHEN $2 = 'ended' AND started_at IS NULL AND status <> 'active' THEN 'failed'
                      ELSE $2 END,
        auth_method = COALESCE($3, auth_method),
        started_at = CASE WHEN $4 AND started_at IS NULL THEN now() ELSE started_at END,
        ended_at = CASE WHEN $5 AND ended_at IS NULL THEN now() ELSE ended_at END,
        end_reason = COALESCE($6, end_reason)
       WHERE id = $1`,
      [id, p.status ?? null, p.authMethod ?? null, Boolean(p.started), Boolean(p.ended), p.endReason ?? null],
    );
  }

  async forDevice(deviceId: string, limit = 50): Promise<SessionRow[]> {
    const r = await this.db.query(`${SESSION_SELECT} WHERE s.host_id = $1 OR s.client_id = $1 ORDER BY s.created_at DESC LIMIT $2`, [
      deviceId,
      Math.min(200, limit),
    ]);
    return r.rows.map(mapSession);
  }

  async forOwner(userId: string, limit = 100): Promise<SessionRow[]> {
    const r = await this.db.query(
      `${SESSION_SELECT} WHERE h.owner_id = $1 OR c.owner_id = $1 ORDER BY s.created_at DESC LIMIT $2`,
      [userId, Math.min(500, limit)],
    );
    return r.rows.map(mapSession);
  }
}

export class AuditLog {
  constructor(private readonly db: Database) {}

  async log(e: { actorType: string; actorId: string | null; action: string; target?: string | null; ip?: string | null; details?: unknown }) {
    await this.db.query('INSERT INTO audit_log (actor_type, actor_id, action, target, ip, details) VALUES ($1,$2,$3,$4,$5,$6)', [
      e.actorType,
      e.actorId,
      e.action,
      e.target ?? null,
      e.ip ?? null,
      JSON.stringify(e.details ?? {}),
    ]);
  }

  async list(limit = 100, actorId?: string) {
    const r = actorId
      ? await this.db.query('SELECT * FROM audit_log WHERE actor_id = $1 OR target = $1 ORDER BY at DESC LIMIT $2', [actorId, Math.min(500, limit)])
      : await this.db.query('SELECT * FROM audit_log ORDER BY at DESC LIMIT $1', [Math.min(500, limit)]);
    return r.rows.map((x) => ({ ...x, id: Number(x.id), at: new Date(x.at).toISOString() }));
  }
}
