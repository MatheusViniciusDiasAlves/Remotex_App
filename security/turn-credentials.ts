/**
 * Credenciais temporárias para TURN (coturn com "use-auth-secret"), conforme o padrão
 * "TURN REST API": username = "<expiração>:<id>", senha = base64(HMAC-SHA1(segredo, username)).
 * As credenciais expiram sozinhas; o segredo nunca sai do servidor.
 */
import { createHmac } from 'node:crypto';
import type { IceServer } from '@remotex/signaling/protocol';

export interface TurnConfig {
  stunUrls: string[];
  turnUrls: string[];
  secret: string | null;
  ttlSeconds: number;
}

export function turnCredentials(secret: string, id: string, ttlSeconds: number, nowSec = Math.floor(Date.now() / 1000)) {
  const username = `${nowSec + ttlSeconds}:${id}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

export function iceServersFor(cfg: TurnConfig, deviceId: string): IceServer[] {
  const out: IceServer[] = [];
  if (cfg.stunUrls.length) out.push({ urls: cfg.stunUrls });
  if (cfg.turnUrls.length && cfg.secret) {
    out.push({ urls: cfg.turnUrls, ...turnCredentials(cfg.secret, deviceId, cfg.ttlSeconds) });
  }
  return out;
}
