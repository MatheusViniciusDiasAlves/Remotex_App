/**
 * API HTTP do RemoteX (Express 5).
 *
 * Autenticação:
 *  - Contas de usuário: "Authorization: Bearer <JWT>" (15 min) + refresh token rotativo.
 *  - Dispositivos: "Authorization: Device <id>:<token>".
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Database } from '@remotex/database/db';
import { DeviceRegistry, type DeviceRecord } from '@remotex/devices/device-registry';
import { LockoutTracker, SlidingWindowLimiter } from '@remotex/security/rate-limiter';
import { iceServersFor } from '@remotex/security/turn-credentials';
import { isValidDeviceId } from '@remotex/shared/ids';
import { APP_VERSION, PROTOCOL_VERSION } from '@remotex/shared/version';
import type { AccessClaims } from '@remotex/auth/jwt';
import type { ServerConfig } from './config';
import { AccountService, AuditLog, HttpError, SessionHistory } from './services';

export interface PresenceProvider {
  isOnline(id: string): boolean;
  disconnectDevice(id: string, reason?: string): void;
  stats(): { hostsOnline: number; clientsOnline: number; sessions: number };
}

export interface AppDeps {
  config: ServerConfig;
  db: Database;
  devices: DeviceRegistry;
  accounts: AccountService;
  history: SessionHistory;
  audit: AuditLog;
  presence: () => PresenceProvider | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AccessClaims;
    device?: DeviceRecord;
    clientIp?: string | null;
  }
}

const nameSchema = z.string().trim().min(1).max(64);
const passwordSchema = z.string().min(8).max(128);

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, 'BAD_REQUEST', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

export function createApp(deps: AppDeps) {
  const { config, devices, accounts, history, audit } = deps;
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);

  const registerLimiter = new SlidingWindowLimiter(30, 60 * 60_000);
  const loginLimiter = new SlidingWindowLimiter(20, 15 * 60_000);
  const loginLockout = new LockoutTracker(5, 60_000, 30 * 60_000);
  const apiLimiter = new SlidingWindowLimiter(600, 60_000);
  setInterval(() => {
    registerLimiter.sweep();
    loginLimiter.sweep();
    apiLimiter.sweep();
  }, 60_000).unref();

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          'media-src': ["'self'", 'blob:', 'mediastream:'],
          'connect-src': ["'self'", 'ws:', 'wss:'],
          'worker-src': ["'self'", 'blob:'],
          'upgrade-insecure-requests': null,
        },
      },
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: config.production,
    }),
  );
  app.use(express.json({ limit: '64kb' }));

  app.use((req, res, next) => {
    req.clientIp = req.ip ?? req.socket.remoteAddress ?? null;
    const origin = req.headers.origin;
    if (origin && (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', config.corsOrigins.includes('*') ? '*' : origin);
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return void res.status(204).end();
    if (req.path.startsWith('/api/') && !apiLimiter.hit(req.clientIp || '?')) {
      return void res.status(429).json({ error: 'RATE_LIMITED', message: 'Muitas requisições' });
    }
    next();
  });

  // ---- autenticação --------------------------------------------------------------------------
  async function optionalUser(req: Request) {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) {
      const claims = await accounts.jwt.verify(h.slice(7));
      if (!claims) throw new HttpError(401, 'BAD_TOKEN', 'Token expirado ou inválido');
      req.user = claims;
    }
  }

  const requireUser = async (req: Request, _res: Response, next: NextFunction) => {
    await optionalUser(req);
    if (!req.user) throw new HttpError(401, 'UNAUTHORIZED', 'Faça login');
    const u = await accounts.get(req.user.sub);
    if (!u || u.disabled) throw new HttpError(403, 'DISABLED', 'Conta desativada');
    next();
  };

  const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
    await requireUser(req, res, () => undefined);
    if (req.user?.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', 'Apenas administradores');
    next();
  };

  const requireDevice = async (req: Request, _res: Response, next: NextFunction) => {
    const h = req.headers.authorization || '';
    const m = /^Device (\d{9}):([0-9a-f]{64})$/.exec(h);
    if (!m) throw new HttpError(401, 'UNAUTHORIZED', 'Credenciais do dispositivo ausentes');
    const dev = await devices.authenticate(m[1], m[2]);
    if (dev === 'revoked') throw new HttpError(403, 'REVOKED', 'Dispositivo revogado');
    if (!dev) throw new HttpError(401, 'UNAUTHORIZED', 'Credenciais do dispositivo inválidas');
    req.device = dev;
    next();
  };

  const presence = () => deps.presence();
  const publicDevice = (d: DeviceRecord) => ({
    id: d.id,
    kind: d.kind,
    name: d.name,
    platform: d.platform,
    appVersion: d.appVersion,
    owner: d.ownerEmail,
    online: presence()?.isOnline(d.id) ?? false,
    lastSeenAt: d.lastSeenAt,
    createdAt: d.createdAt,
  });

  // ---- sistema ------------------------------------------------------------------------------
  app.get('/api/health', async (_req, res) => {
    const dbOk = await deps.db.ping();
    res.status(dbOk ? 200 : 503).json({ ok: dbOk, version: APP_VERSION, protocol: PROTOCOL_VERSION, time: new Date().toISOString() });
  });

  // ---- contas -------------------------------------------------------------------------------
  app.post('/api/auth/register', async (req, res) => {
    if (!config.allowRegistration) throw new HttpError(403, 'REGISTRATION_DISABLED', 'Cadastro desabilitado neste servidor');
    if (!registerLimiter.hit(`acc:${req.clientIp}`)) throw new HttpError(429, 'RATE_LIMITED', 'Muitas tentativas');
    const body = parse(z.object({ email: z.string().email().max(254), name: nameSchema, password: passwordSchema }), req.body);
    const user = await accounts.register(body.email, body.name, body.password);
    await audit.log({ actorType: 'user', actorId: user.id, action: 'account.registered', ip: req.clientIp });
    res.status(201).json(await accounts.issueTokens(user, req.headers['user-agent'] ?? null));
  });

  app.post('/api/auth/login', async (req, res) => {
    const body = parse(z.object({ email: z.string().max(254), password: z.string().max(128) }), req.body);
    const key = body.email.trim().toLowerCase();
    const locked = loginLockout.isLocked(key);
    if (locked) throw new HttpError(429, 'LOCKED', `Conta bloqueada temporariamente. Tente em ${Math.ceil(locked / 1000)} s.`);
    if (!loginLimiter.hit(`ip:${req.clientIp}`)) throw new HttpError(429, 'RATE_LIMITED', 'Muitas tentativas. Aguarde.');
    try {
      const out = await accounts.login(body.email, body.password, req.headers['user-agent'] ?? null);
      loginLockout.success(key);
      await audit.log({ actorType: 'user', actorId: out.user.id, action: 'account.login', ip: req.clientIp });
      res.json(out);
    } catch (err) {
      if (err instanceof HttpError && err.code === 'BAD_CREDENTIALS') {
        loginLockout.fail(key);
        await audit.log({ actorType: 'user', actorId: null, action: 'account.login_failed', target: key, ip: req.clientIp });
      }
      throw err;
    }
  });

  app.post('/api/auth/refresh', async (req, res) => {
    const body = parse(z.object({ refreshToken: z.string().max(200) }), req.body);
    res.json(await accounts.refresh(body.refreshToken, req.headers['user-agent'] ?? null));
  });

  app.post('/api/auth/logout', async (req, res) => {
    const body = parse(z.object({ refreshToken: z.string().max(200) }), req.body);
    await accounts.logout(body.refreshToken);
    res.status(204).end();
  });

  app.get('/api/me', requireUser, async (req, res) => {
    res.json({ user: await accounts.get(req.user!.sub) });
  });

  // ---- dispositivos -------------------------------------------------------------------------
  app.post('/api/devices/register', async (req, res) => {
    await optionalUser(req);
    if (!registerLimiter.hit(`dev:${req.clientIp}`)) throw new HttpError(429, 'RATE_LIMITED', 'Muitos registros a partir deste IP');
    const body = parse(
      z.object({
        kind: z.enum(['host', 'client']),
        name: nameSchema,
        platform: z.string().max(64).default(''),
        appVersion: z.string().max(32).default(''),
        publicKey: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      }),
      req.body,
    );
    const { device, token } = await devices.register({ ...body, ownerId: req.user?.sub ?? null, ip: req.clientIp });
    await audit.log({ actorType: 'device', actorId: device.id, action: 'device.registered', ip: req.clientIp, details: { kind: device.kind, name: device.name } });
    res.status(201).json({ deviceId: device.id, token, device: publicDevice(device) });
  });

  app.get('/api/devices/me', requireDevice, async (req, res) => {
    res.json({ device: publicDevice(req.device!) });
  });

  app.patch('/api/devices/me', requireDevice, async (req, res) => {
    const body = parse(
      z.object({
        name: nameSchema.optional(),
        publicKey: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        platform: z.string().max(64).optional(),
        appVersion: z.string().max(32).optional(),
      }),
      req.body,
    );
    const d = await devices.update(req.device!.id, body);
    res.json({ device: publicDevice(d!) });
  });

  app.get('/api/devices/status', async (req, res) => {
    const ids = String(req.query.ids || '')
      .split(',')
      .map((s) => s.replace(/\D/g, ''))
      .filter(isValidDeviceId)
      .slice(0, 50);
    const p = presence();
    res.json({ statuses: Object.fromEntries(ids.map((id) => [id, p?.isOnline(id) ?? false])) });
  });

  app.get('/api/ice-servers', requireDevice, async (req, res) => {
    res.json({ iceServers: iceServersFor(config.turn, req.device!.id), ttl: config.turn.ttlSeconds });
  });

  app.get('/api/devices/me/sessions', requireDevice, async (req, res) => {
    res.json({ sessions: await history.forDevice(req.device!.id, Number(req.query.limit || 50)) });
  });

  app.post('/api/devices/claim', requireUser, async (req, res) => {
    const body = parse(z.object({ deviceId: z.string(), token: z.string() }), req.body);
    const d = await devices.claim(body.deviceId, body.token, req.user!.sub);
    if (!d) throw new HttpError(404, 'NOT_FOUND', 'Dispositivo não encontrado');
    await audit.log({ actorType: 'user', actorId: req.user!.sub, action: 'device.claimed', target: d.id, ip: req.clientIp });
    res.json({ device: publicDevice(d) });
  });

  app.get('/api/devices', requireUser, async (req, res) => {
    res.json({ devices: (await devices.listByOwner(req.user!.sub)).map(publicDevice) });
  });

  async function ownedDevice(req: Request): Promise<DeviceRecord> {
    const d = await devices.get(String(req.params.id));
    if (!d || (d.ownerId !== req.user!.sub && req.user!.role !== 'admin')) throw new HttpError(404, 'NOT_FOUND', 'Dispositivo não encontrado');
    return d;
  }

  app.patch('/api/devices/:id', requireUser, async (req, res) => {
    const d = await ownedDevice(req);
    const body = parse(z.object({ name: nameSchema }), req.body);
    res.json({ device: publicDevice((await devices.update(d.id, { name: body.name }))!) });
  });

  app.delete('/api/devices/:id', requireUser, async (req, res) => {
    const d = await ownedDevice(req);
    await devices.revoke(d.id);
    presence()?.disconnectDevice(d.id, 'revoked');
    await audit.log({ actorType: 'user', actorId: req.user!.sub, action: 'device.revoked', target: d.id, ip: req.clientIp });
    res.status(204).end();
  });

  app.get('/api/sessions', requireUser, async (req, res) => {
    res.json({ sessions: await history.forOwner(req.user!.sub, Number(req.query.limit || 100)) });
  });

  // ---- administração -----------------------------------------------------------------------
  app.get('/api/admin/users', requireAdmin, async (_req, res) => {
    res.json({ users: await accounts.list() });
  });

  app.patch('/api/admin/users/:id', requireAdmin, async (req, res) => {
    const body = parse(z.object({ disabled: z.boolean().optional(), role: z.enum(['user', 'admin']).optional(), name: nameSchema.optional() }), req.body);
    if (req.params.id === req.user!.sub && (body.disabled || body.role === 'user')) {
      throw new HttpError(400, 'SELF_LOCKOUT', 'Você não pode remover seu próprio acesso de administrador');
    }
    const u = await accounts.update(String(req.params.id), body);
    if (!u) throw new HttpError(404, 'NOT_FOUND', 'Usuário não encontrado');
    await audit.log({ actorType: 'user', actorId: req.user!.sub, action: 'admin.user_updated', target: u.id, ip: req.clientIp, details: body });
    res.json({ user: u });
  });

  app.get('/api/admin/audit', requireAdmin, async (req, res) => {
    res.json({ entries: await audit.list(Number(req.query.limit || 100), req.query.actor ? String(req.query.actor) : undefined) });
  });

  app.get('/api/admin/stats', requireAdmin, async (_req, res) => {
    res.json({ devices: await devices.countByKind(), ...(presence()?.stats() ?? {}) });
  });

  app.use('/api', (_req, _res) => {
    throw new HttpError(404, 'NOT_FOUND', 'Rota inexistente');
  });

  // ---- arquivos estáticos: app web (cliente) e downloads (instalador/APK) ---------------------
  if (config.downloadsDir && fs.existsSync(config.downloadsDir)) {
    app.use('/download', express.static(config.downloadsDir, { index: false, fallthrough: true }));
  }
  if (config.publicDir && fs.existsSync(config.publicDir)) {
    const dir = config.publicDir;
    app.use(express.static(dir, { index: 'index.html', maxAge: config.production ? '1h' : 0 }));
    app.get(/^\/(?!api\/|ws$|download\/).*/, (_req, res) => res.sendFile(path.join(dir, 'index.html')));
  }

  // ---- erros --------------------------------------------------------------------------------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.code, message: err.message });
    if ((err as any)?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'BAD_JSON', message: 'JSON inválido' });
    if ((err as any)?.type === 'entity.too.large') return void res.status(413).json({ error: 'TOO_LARGE', message: 'Requisição grande demais' });
    console.error('[api] erro', err);
    res.status(500).json({ error: 'INTERNAL', message: 'Erro interno do servidor' });
  });

  return app;
}
