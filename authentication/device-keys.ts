/**
 * Identidade criptográfica de dispositivos (Ed25519).
 *
 * - Cada computador (host) tem um par de chaves; o celular fixa (TOFU/pinning) a chave pública
 *   do host por ID e alerta se ela mudar — protege contra um servidor de sinalização malicioso.
 * - Cada celular (cliente) tem um par de chaves; o host guarda a chave pública dos dispositivos
 *   confiáveis e exige assinatura em cada conexão não assistida (não depende do servidor).
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromHex, toHex, utf8 } from '@remotex/shared/encoding';

export interface DeviceKeyPair {
  publicKey: string; // hex
  secretKey: string; // hex — segredo
}

export function generateDeviceKeyPair(): DeviceKeyPair {
  const { secretKey, publicKey } = ed25519.keygen();
  return { publicKey: toHex(publicKey), secretKey: toHex(secretKey) };
}

export function publicKeyFromSecret(secretKeyHex: string): string {
  return toHex(ed25519.getPublicKey(fromHex(secretKeyHex)));
}

export function signMessage(secretKeyHex: string, message: string): string {
  return toHex(ed25519.sign(utf8(message), fromHex(secretKeyHex)));
}

export function verifySignature(publicKeyHex: string, message: string, signatureHex: string): boolean {
  try {
    return ed25519.verify(fromHex(signatureHex), utf8(message), fromHex(publicKeyHex));
  } catch {
    return false;
  }
}

const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Impressão digital curta e legível de uma chave pública: "K7QF-2M9X-..." (80 bits). */
export function keyFingerprint(publicKeyHex: string): string {
  const h = sha256(fromHex(publicKeyHex));
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < 10; i++) {
    value = (value << 8) | h[i];
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{1,4}/g)!.join('-');
}

export function hostIdentityMessage(sessionId: string, hostId: string, clientNonce: string, hostNonce: string): string {
  return ['remotex-host-v1', sessionId, hostId, clientNonce, hostNonce].join('|');
}

export function clientIdentityMessage(
  sessionId: string,
  hostId: string,
  clientDeviceId: string,
  hostNonce: string,
  clientNonce: string,
): string {
  return ['remotex-client-v1', sessionId, hostId, clientDeviceId, hostNonce, clientNonce].join('|');
}
