/** Configuração do servidor RemoteX via variáveis de ambiente (ver deploy/.env.example). */
import { randomBytes } from 'node:crypto';
import path from 'node:path';

function list(v: string | undefined): string[] {
  return (v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface ServerConfig {
  port: number;
  host: string;
  databaseUrl: string;
  jwtSecret: string;
  production: boolean;
  trustProxy: boolean;
  publicDir: string | null;
  downloadsDir: string | null;
  allowRegistration: boolean;
  corsOrigins: string[];
  turn: { stunUrls: string[]; turnUrls: string[]; secret: string | null; ttlSeconds: number };
  autoMigrate: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === 'production';
  let jwtSecret = env.JWT_SECRET || '';
  if (!jwtSecret) {
    if (production) throw new Error('JWT_SECRET é obrigatório em produção');
    jwtSecret = randomBytes(32).toString('hex');
    console.warn('[config] JWT_SECRET ausente: usando segredo aleatório (sessões de conta não sobrevivem a reinícios)');
  }
  const databaseUrl = env.DATABASE_URL || '';
  if (!databaseUrl) throw new Error('DATABASE_URL é obrigatório (ex.: postgres://remotex:senha@localhost:5432/remotex)');
  const defaultPublic = path.resolve(process.cwd(), 'android-app/web/dist');
  return {
    port: Number(env.PORT || 8080),
    host: env.HOST || '0.0.0.0',
    databaseUrl,
    jwtSecret,
    production,
    trustProxy: env.TRUST_PROXY === 'true' || env.TRUST_PROXY === '1',
    publicDir: env.PUBLIC_DIR === '' ? null : env.PUBLIC_DIR || defaultPublic,
    downloadsDir: env.DOWNLOADS_DIR || null,
    allowRegistration: env.ALLOW_REGISTRATION !== 'false',
    corsOrigins: list(env.CORS_ORIGINS || '*'),
    turn: {
      stunUrls: list(env.STUN_URLS),
      turnUrls: list(env.TURN_URLS),
      secret: env.TURN_SECRET || null,
      ttlSeconds: Number(env.TURN_TTL || 6 * 3600),
    },
    autoMigrate: env.AUTO_MIGRATE !== 'false',
  };
}
