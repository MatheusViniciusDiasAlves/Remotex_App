/**
 * Autenticação por senha de acesso (acesso não assistido) — desafio/resposta.
 *
 * A senha nunca trafega pela rede. O computador guarda apenas um verificador
 * K = scrypt(senha, salt). O cliente recebe salt/parâmetros, deriva K localmente e
 * responde com HMAC-SHA256(K, contexto) amarrado à sessão e a nonces aleatórios de ambos
 * os lados, impedindo replay. Depois que o WebRTC conecta, K também é usado para provar que
 * as impressões digitais DTLS vistas pelos dois lados são as mesmas (anti-MITM; ver binding.ts).
 */
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { constantTimeEqual, fromHex, randomBytes, toHex, utf8 } from '@remotex/shared/encoding';

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };

/** Limites aceitos pelo cliente — impede que um host malicioso force custos absurdos. */
export function isAcceptableScrypt(p: ScryptParams): boolean {
  const pow2 = (n: number) => n > 1 && (n & (n - 1)) === 0;
  return pow2(p.N) && p.N >= 2 ** 12 && p.N <= 2 ** 17 && p.r >= 1 && p.r <= 16 && p.p >= 1 && p.p <= 4;
}

export interface PasswordVerifier {
  salt: string; // hex
  params: ScryptParams;
  key: string; // hex — segredo! armazenar criptografado (DPAPI/safeStorage)
}

export async function deriveAccessKey(password: string, saltHex: string, params: ScryptParams): Promise<Uint8Array> {
  if (!isAcceptableScrypt(params)) throw new Error('Parâmetros scrypt fora dos limites aceitos');
  return scryptAsync(utf8(password.normalize('NFC')), fromHex(saltHex), {
    N: params.N,
    r: params.r,
    p: params.p,
    dkLen: 32,
  });
}

export async function createPasswordVerifier(password: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<PasswordVerifier> {
  const salt = toHex(randomBytes(16));
  const key = await deriveAccessKey(password, salt, params);
  return { salt, params, key: toHex(key) };
}

export interface AuthContext {
  sessionId: string;
  hostId: string;
  clientDeviceId: string;
  hostNonce: string;
  clientNonce: string;
}

export function authContextString(ctx: AuthContext): string {
  return ['remotex-auth-v1', ctx.sessionId, ctx.hostId, ctx.clientDeviceId, ctx.hostNonce, ctx.clientNonce].join('|');
}

export function computeAuthProof(key: Uint8Array, ctx: AuthContext): string {
  return toHex(hmac(sha256, key, utf8(authContextString(ctx))));
}

export function verifyAuthProof(keyHex: string, ctx: AuthContext, proofHex: string): boolean {
  try {
    const expected = hmac(sha256, fromHex(keyHex), utf8(authContextString(ctx)));
    return constantTimeEqual(expected, fromHex(proofHex));
  } catch {
    return false;
  }
}

export function hmacHex(keyHex: string | Uint8Array, message: string): string {
  const key = typeof keyHex === 'string' ? fromHex(keyHex) : keyHex;
  return toHex(hmac(sha256, key, utf8(message)));
}

export function verifyHmacHex(keyHex: string, message: string, macHex: string): boolean {
  try {
    return constantTimeEqual(hmac(sha256, fromHex(keyHex), utf8(message)), fromHex(macHex));
  } catch {
    return false;
  }
}
