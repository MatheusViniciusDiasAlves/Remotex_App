import { describe, expect, it } from 'vitest';
import {
  computeAuthProof,
  createPasswordVerifier,
  deriveAccessKey,
  isAcceptableScrypt,
  verifyAuthProof,
  type AuthContext,
} from '@remotex/auth/password';
import {
  clientIdentityMessage,
  generateDeviceKeyPair,
  keyFingerprint,
  publicKeyFromSecret,
  signMessage,
  verifySignature,
} from '@remotex/auth/device-keys';
import { bindingMessage, extractDtlsFingerprint, sessionVerificationCode } from '@remotex/auth/binding';

const FAST = { N: 2 ** 12, r: 8, p: 1 };
const ctx: AuthContext = { sessionId: 's1', hostId: '123456789', clientDeviceId: '987654321', hostNonce: 'hn', clientNonce: 'cn' };

describe('senha de acesso (desafio/resposta)', () => {
  it('prova correta é aceita e senha errada é recusada', async () => {
    const v = await createPasswordVerifier('Senha-Forte-2026', FAST);
    const k = await deriveAccessKey('Senha-Forte-2026', v.salt, v.params);
    const proof = computeAuthProof(k, ctx);
    expect(verifyAuthProof(v.key, ctx, proof)).toBe(true);
    const wrong = await deriveAccessKey('senha-errada-1', v.salt, v.params);
    expect(verifyAuthProof(v.key, ctx, computeAuthProof(wrong, ctx))).toBe(false);
  });
  it('prova não pode ser reutilizada em outra sessão (anti-replay)', async () => {
    const v = await createPasswordVerifier('Senha-Forte-2026', FAST);
    const k = await deriveAccessKey('Senha-Forte-2026', v.salt, v.params);
    const proof = computeAuthProof(k, ctx);
    expect(verifyAuthProof(v.key, { ...ctx, sessionId: 's2' }, proof)).toBe(false);
    expect(verifyAuthProof(v.key, { ...ctx, hostNonce: 'outro' }, proof)).toBe(false);
  });
  it('normaliza Unicode (acentos compostos e decompostos)', async () => {
    const v = await createPasswordVerifier('Ação-2026x', FAST);
    const k = await deriveAccessKey('Ação-2026x', v.salt, v.params);
    expect(verifyAuthProof(v.key, ctx, computeAuthProof(k, ctx))).toBe(true);
  });
  it('recusa parâmetros scrypt abusivos', async () => {
    expect(isAcceptableScrypt({ N: 2 ** 20, r: 8, p: 1 })).toBe(false);
    expect(isAcceptableScrypt({ N: 1000, r: 8, p: 1 })).toBe(false);
    await expect(deriveAccessKey('x', '00', { N: 2 ** 22, r: 8, p: 1 })).rejects.toThrow();
  });
  it('custo padrão (N=2^15) é aceitável', async () => {
    const t0 = Date.now();
    await createPasswordVerifier('Senha-Forte-2026');
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe('chaves de dispositivo Ed25519', () => {
  it('assina e verifica; detecta adulteração', () => {
    const kp = generateDeviceKeyPair();
    expect(publicKeyFromSecret(kp.secretKey)).toBe(kp.publicKey);
    const msg = clientIdentityMessage('s', 'h', 'c', 'hn', 'cn');
    const sig = signMessage(kp.secretKey, msg);
    expect(verifySignature(kp.publicKey, msg, sig)).toBe(true);
    expect(verifySignature(kp.publicKey, msg + 'x', sig)).toBe(false);
    expect(verifySignature(generateDeviceKeyPair().publicKey, msg, sig)).toBe(false);
    expect(verifySignature('zz', msg, sig)).toBe(false);
  });
  it('impressão digital legível e estável', () => {
    const kp = generateDeviceKeyPair();
    const fp = keyFingerprint(kp.publicKey);
    expect(fp).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(keyFingerprint(kp.publicKey)).toBe(fp);
  });
});

describe('amarração de canal', () => {
  const sdp = 'v=0\r\na=fingerprint:sha-256 ab:cd:EF:01\r\n';
  it('extrai fingerprint DTLS', () => {
    expect(extractDtlsFingerprint(sdp)).toBe('sha-256 AB:CD:EF:01');
    expect(extractDtlsFingerprint('v=0')).toBeNull();
  });
  it('código de verificação de 6 dígitos determinístico', () => {
    const a = sessionVerificationCode('h', 'c');
    expect(a).toMatch(/^\d{3} \d{3}$/);
    expect(sessionVerificationCode('h', 'c')).toBe(a);
    expect(sessionVerificationCode('h', 'x')).not.toBe(a);
    expect(bindingMessage('s', 'h', 'c')).toBe('remotex-bind-v1|s|h|c');
  });
});
