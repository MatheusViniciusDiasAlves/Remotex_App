/**
 * Autorização de acesso ao computador (executada no próprio computador, ponta a ponta).
 *
 * Métodos (configuráveis pelo dono):
 *  - "approval": alguém no computador aprova o pedido (com escolha de permissões);
 *  - "password": senha de acesso não assistido (desafio/resposta scrypt+HMAC);
 *  - "device": dispositivo confiável previamente aprovado, comprovado por assinatura Ed25519.
 *
 * Proteção contra força bruta: até 3 tentativas por sessão e bloqueio exponencial global da senha
 * após 5 falhas (1 min, 2 min, 4 min... até 1 h).
 */
import { hostIdentityMessage, clientIdentityMessage, keyFingerprint, signMessage, verifySignature } from '@remotex/auth/device-keys';
import { verifyAuthProof } from '@remotex/auth/password';
import { LockoutTracker } from '@remotex/security/rate-limiter';
import { intersect, type PermissionSet } from '@remotex/security/permissions';
import { randomToken } from '@remotex/shared/ids';
import type { AuthMethod, PeerInfo, RelayPayload } from '@remotex/signaling/protocol';
import type { ConfigStore, TrustedDevice } from './config-store';

export interface ApprovalDecision {
  accept: boolean;
  permissions: PermissionSet;
  trust: boolean;
  unattended: boolean;
}

export interface PendingAuth {
  sessionId: string;
  client: PeerInfo;
  clientNonce: string;
  hostNonce: string;
  attempts: number;
  clientPublicKey: string | null;
  clientName: string;
  requestedAt: number;
  methods: AuthMethod[];
  approvalOpen: boolean;
}

export type AuthOutcome =
  | { type: 'reply'; payload: RelayPayload }
  | { type: 'approval'; pending: PendingAuth }
  | {
      type: 'authorized';
      payload: RelayPayload;
      method: AuthMethod;
      permissions: PermissionSet;
      clientPublicKey: string;
      clientName: string;
      client: PeerInfo;
      bindingKey: string | null;
      trusted: boolean;
    }
  | { type: 'rejected'; payload: RelayPayload; reason: string; final: boolean };

const MAX_ATTEMPTS_PER_SESSION = 3;

export class AuthManager {
  readonly lockout = new LockoutTracker(5, 60_000, 60 * 60_000);
  private pending = new Map<string, PendingAuth>();

  constructor(
    private readonly store: ConfigStore,
    private readonly hostId: () => string,
  ) {}

  get(sessionId: string): PendingAuth | undefined {
    return this.pending.get(sessionId);
  }

  drop(sessionId: string): void {
    this.pending.delete(sessionId);
  }

  availableMethods(): AuthMethod[] {
    const c = this.store.get();
    const m: AuthMethod[] = [];
    if (c.unattendedEnabled && c.trusted.some((t) => t.unattended)) m.push('device');
    if (c.unattendedEnabled && c.password && !this.lockout.isLocked('password')) m.push('password');
    if (c.attendedEnabled) m.push('approval');
    return m;
  }

  /** Início: monta o "auth.hello" assinado pela chave do computador. */
  begin(sessionId: string, client: PeerInfo, clientNonce: string): RelayPayload {
    const c = this.store.get();
    const hostNonce = randomToken(16);
    const methods = this.availableMethods();
    const p: PendingAuth = {
      sessionId,
      client,
      clientNonce,
      hostNonce,
      attempts: 0,
      clientPublicKey: null,
      clientName: client.name,
      requestedAt: Date.now(),
      methods,
      approvalOpen: false,
    };
    this.pending.set(sessionId, p);
    const hostKey = c.hostKey!;
    return {
      k: 'auth.hello',
      methods,
      hostName: c.deviceName,
      hostPublicKey: hostKey.publicKey,
      hostSignature: signMessage(hostKey.secretKey, hostIdentityMessage(sessionId, this.hostId(), clientNonce, hostNonce)),
      hostNonce,
      password: methods.includes('password') && c.password ? { salt: c.password.salt, params: c.password.params } : undefined,
      lockedForMs: this.lockout.isLocked('password') || undefined,
    };
  }

  private trustedByKey(pub: string): TrustedDevice | undefined {
    return this.store.get().trusted.find((t) => t.publicKey === pub);
  }

  private checkClientSignature(p: PendingAuth, pub: string, sig: string): boolean {
    if (typeof pub !== 'string' || !/^[0-9a-f]{64}$/.test(pub)) return false;
    return verifySignature(pub, clientIdentityMessage(p.sessionId, this.hostId(), p.client.id, p.hostNonce, p.clientNonce), sig);
  }

  handle(sessionId: string, msg: RelayPayload): AuthOutcome | null {
    const p = this.pending.get(sessionId);
    if (!p) return null;
    const c = this.store.get();
    switch (msg.k) {
      case 'auth.password': {
        if (!p.methods.includes('password') || !c.password) return this.reject(p, 'METHOD_UNAVAILABLE', 'Acesso por senha desativado', true);
        const locked = this.lockout.isLocked('password');
        if (locked) return this.reject(p, 'LOCKED', `Muitas tentativas. Senha bloqueada por ${Math.ceil(locked / 1000)} s.`, true);
        if (!this.checkClientSignature(p, msg.clientPublicKey, msg.clientSignature)) return this.reject(p, 'BAD_SIGNATURE', 'Identidade do dispositivo inválida', true);
        p.attempts++;
        const ok = verifyAuthProof(c.password.key, {
          sessionId,
          hostId: this.hostId(),
          clientDeviceId: p.client.id,
          hostNonce: p.hostNonce,
          clientNonce: p.clientNonce,
        }, String(msg.proof || ''));
        if (!ok) {
          const lockedNow = this.lockout.fail('password');
          const retry = p.attempts < MAX_ATTEMPTS_PER_SESSION && !lockedNow;
          return this.reject(p, lockedNow ? 'LOCKED' : 'BAD_PASSWORD', lockedNow ? 'Muitas tentativas incorretas. Acesso por senha bloqueado temporariamente.' : 'Senha incorreta', !retry, retry);
        }
        this.lockout.success('password');
        p.clientPublicKey = msg.clientPublicKey;
        p.clientName = String(msg.clientName || p.client.name).slice(0, 64);
        const trusted = this.trustedByKey(msg.clientPublicKey);
        const perms = intersect(c.policy, trusted ? trusted.permissions : c.passwordPermissions);
        return this.authorize(p, 'password', perms, c.password.key, Boolean(trusted));
      }
      case 'auth.device': {
        const t = this.trustedByKey(msg.clientPublicKey);
        if (!p.methods.includes('device') || !t || !t.unattended) return this.reject(p, 'METHOD_UNAVAILABLE', 'Este dispositivo não tem acesso não assistido', false, true);
        if (!this.checkClientSignature(p, msg.clientPublicKey, msg.clientSignature)) return this.reject(p, 'BAD_SIGNATURE', 'Assinatura do dispositivo inválida', true);
        p.clientPublicKey = msg.clientPublicKey;
        p.clientName = String(msg.clientName || t.name).slice(0, 64);
        return this.authorize(p, 'device', intersect(c.policy, t.permissions), null, true);
      }
      case 'auth.approval': {
        if (!p.methods.includes('approval')) return this.reject(p, 'METHOD_UNAVAILABLE', 'Aprovação manual desativada neste computador', true);
        if (!this.checkClientSignature(p, msg.clientPublicKey, msg.clientSignature)) return this.reject(p, 'BAD_SIGNATURE', 'Identidade do dispositivo inválida', true);
        if (p.approvalOpen) return null;
        p.clientPublicKey = msg.clientPublicKey;
        p.clientName = String(msg.clientName || p.client.name).slice(0, 64);
        p.approvalOpen = true;
        return { type: 'approval', pending: p };
      }
      default:
        return null;
    }
  }

  /** Resultado da janela de aprovação exibida no computador. */
  decide(sessionId: string, d: ApprovalDecision | 'timeout'): AuthOutcome | null {
    const p = this.pending.get(sessionId);
    if (!p || !p.approvalOpen || !p.clientPublicKey) return null;
    p.approvalOpen = false;
    if (d === 'timeout') return this.reject(p, 'TIMEOUT', 'Ninguém respondeu no computador', true);
    if (!d.accept) return this.reject(p, 'REJECTED', 'Acesso recusado no computador', true);
    const c = this.store.get();
    const perms = intersect(c.policy, d.permissions);
    if (d.trust) this.trust(p.client.id, p.clientName, p.clientPublicKey, perms, d.unattended);
    return this.authorize(p, 'approval', perms, null, d.trust);
  }

  trust(deviceId: string, name: string, publicKey: string, permissions: PermissionSet, unattended: boolean): void {
    this.store.update((c) => {
      const existing = c.trusted.find((t) => t.publicKey === publicKey);
      if (existing) {
        Object.assign(existing, { name, permissions, unattended, deviceId, lastSeenAt: new Date().toISOString() });
      } else {
        c.trusted.push({
          deviceId,
          name,
          publicKey,
          fingerprint: keyFingerprint(publicKey),
          permissions,
          unattended,
          addedAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        });
      }
    });
  }

  private authorize(p: PendingAuth, method: AuthMethod, permissions: PermissionSet, bindingKey: string | null, trusted: boolean): AuthOutcome {
    this.pending.delete(p.sessionId);
    if (trusted) {
      this.store.update((c) => {
        const t = c.trusted.find((x) => x.publicKey === p.clientPublicKey);
        if (t) t.lastSeenAt = new Date().toISOString();
      });
    }
    return {
      type: 'authorized',
      method,
      permissions,
      clientPublicKey: p.clientPublicKey!,
      clientName: p.clientName,
      client: p.client,
      bindingKey,
      trusted,
      payload: { k: 'auth.result', ok: true, permissions, trusted },
    };
  }

  private reject(
    p: PendingAuth,
    code: NonNullable<Extract<RelayPayload, { k: 'auth.result' }>['code']>,
    reason: string,
    final: boolean,
    retry = false,
  ): AuthOutcome {
    if (final) this.pending.delete(p.sessionId);
    return { type: 'rejected', reason, final, payload: { k: 'auth.result', ok: false, code, reason, retry } };
  }
}
