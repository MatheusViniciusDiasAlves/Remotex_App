/** Ponto de entrada do servidor RemoteX: API HTTP + sinalização WebSocket no mesmo processo. */
import http from 'node:http';
import { Database } from '@remotex/database/db';
import { migrate } from '@remotex/database/migrate';
import { DeviceRegistry } from '@remotex/devices/device-registry';
import { JwtService } from '@remotex/auth/jwt';
import { SignalingServer } from '@remotex/signaling/server';
import { iceServersFor } from '@remotex/security/turn-credentials';
import { APP_VERSION } from '@remotex/shared/version';
import { loadConfig, type ServerConfig } from './config';
import { createApp } from './app';
import { AccountService, AuditLog, SessionHistory } from './services';

export interface RunningServer {
  config: ServerConfig;
  server: http.Server;
  signaling: SignalingServer;
  db: Database;
  url: string;
  close(): Promise<void>;
}

export async function startServer(config: ServerConfig = loadConfig()): Promise<RunningServer> {
  const db = new Database(config.databaseUrl);
  if (config.autoMigrate) await migrate(db);
  const devices = new DeviceRegistry(db);
  const accounts = new AccountService(db, new JwtService(config.jwtSecret));
  const history = new SessionHistory(db);
  const audit = new AuditLog(db);

  let signaling: SignalingServer | null = null;
  const app = createApp({ config, db, devices, accounts, history, audit, presence: () => signaling });
  const server = http.createServer(app);

  signaling = new SignalingServer(
    {
      authenticateDevice: async (id, token) => {
        const d = await devices.authenticate(id, token);
        if (!d || d === 'revoked') return d;
        return { id: d.id, kind: d.kind, name: d.name, platform: d.platform, ownerEmail: d.ownerEmail };
      },
      getDevice: async (id) => {
        const d = await devices.get(id);
        return d ? { id: d.id, kind: d.kind, name: d.name, platform: d.platform, ownerEmail: d.ownerEmail, revoked: d.revoked } : null;
      },
      touchDevice: (id, ip) => devices.touch(id, ip),
      createSession: (s) => history.create(s),
      updateSession: (id, p) => history.update(id, p),
      audit: (e) => audit.log(e).catch((err) => console.error('[audit]', err.message)),
      iceServers: (id) => iceServersFor(config.turn, id),
    },
    { trustProxy: config.trustProxy },
  );
  signaling.attach(server);

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  const url = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${port}`;

  return {
    config,
    server,
    signaling,
    db,
    url,
    async close() {
      await signaling!.close();
      await new Promise<void>((r) => server.close(() => r()));
      await db.close();
    },
  };
}

const isMain = process.argv[1] && /server\.(js|ts|mjs|cjs)$/.test(process.argv[1]);
if (isMain) {
  startServer()
    .then((s) => {
      console.log(`[remotex] servidor ${APP_VERSION} ouvindo em ${s.url} (sinalização em /ws)`);
      if (!s.config.turn.turnUrls.length) console.warn('[remotex] TURN não configurado: conexões entre redes com NAT restritivo podem falhar');
      const stop = () => s.close().finally(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((err) => {
      console.error('[remotex] falha ao iniciar:', err.message);
      process.exit(1);
    });
}
