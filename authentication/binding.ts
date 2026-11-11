/**
 * Amarração do canal (channel binding) e código de verificação da sessão.
 *
 * Após a conexão WebRTC, cada lado lê as impressões digitais DTLS (a=fingerprint) da descrição
 * local e remota. Se um intermediário tivesse interceptado a sinalização para fazer MITM, os dois
 * lados veriam pares de impressões diferentes. A prova de amarração (HMAC com a chave da senha
 * ou assinatura Ed25519 do dispositivo) detecta isso e a sessão é encerrada.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8 } from '@remotex/shared/encoding';

export function extractDtlsFingerprint(sdp: string | undefined | null): string | null {
  if (!sdp) return null;
  const m = /a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)/.exec(sdp);
  if (!m) return null;
  return `${m[1].toLowerCase()} ${m[2].toUpperCase()}`;
}

export function bindingMessage(sessionId: string, hostFingerprint: string, clientFingerprint: string): string {
  return ['remotex-bind-v1', sessionId, hostFingerprint, clientFingerprint].join('|');
}

/** Código de 6 dígitos exibido no PC e no celular para conferência visual ("123 456"). */
export function sessionVerificationCode(hostFingerprint: string, clientFingerprint: string): string {
  const h = sha256(utf8(['remotex-sas-v1', hostFingerprint, clientFingerprint].join('|')));
  const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  const code = String(n % 1_000_000).padStart(6, '0');
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}
