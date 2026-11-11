/**
 * Utilitários de codificação independentes de plataforma (navegador, Electron e Node).
 * Não dependem de Buffer para que o mesmo código rode no cliente móvel.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function utf8(text: string): Uint8Array {
  return enc.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return dec.decode(bytes);
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) throw new Error('hex inválido');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63];
  }
  return out;
}

export function fromBase64Url(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const lookup = (c: string) => {
    const v = B64.indexOf(c);
    if (v < 0) throw new Error('base64 inválido');
    return v;
  };
  const out: number[] = [];
  let i = 0;
  for (; i + 3 < clean.length; i += 4) {
    const n = (lookup(clean[i]) << 18) | (lookup(clean[i + 1]) << 12) | (lookup(clean[i + 2]) << 6) | lookup(clean[i + 3]);
    out.push((n >> 16) & 255, (n >> 8) & 255, n & 255);
  }
  const rest = clean.length - i;
  if (rest === 2) {
    const n = (lookup(clean[i]) << 18) | (lookup(clean[i + 1]) << 12);
    out.push((n >> 16) & 255);
  } else if (rest === 3) {
    const n = (lookup(clean[i]) << 18) | (lookup(clean[i + 1]) << 12) | (lookup(clean[i + 2]) << 6);
    out.push((n >> 16) & 255, (n >> 8) & 255);
  } else if (rest === 1) {
    throw new Error('base64 inválido');
  }
  return new Uint8Array(out);
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** Comparação em tempo constante (evita ataques de temporização). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
