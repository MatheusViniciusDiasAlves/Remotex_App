/**
 * IDs de dispositivos RemoteX: 9 dígitos, o primeiro nunca é zero, exibidos como "123 456 789".
 * O último dígito é um dígito verificador (Luhn) para detectar erros de digitação no celular.
 */
import { randomBytes, toHex } from './encoding';

export const DEVICE_ID_LENGTH = 9;

export function luhnCheckDigit(payload: string): number {
  let sum = 0;
  let double = true;
  for (let i = payload.length - 1; i >= 0; i--) {
    let d = payload.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

export function generateDeviceId(): string {
  const bytes = randomBytes(8);
  let digits = String(1 + (bytes[0] % 9));
  for (let i = 1; i < DEVICE_ID_LENGTH - 1; i++) digits += String(bytes[i] % 10);
  return digits + String(luhnCheckDigit(digits));
}

export function normalizeDeviceId(input: string): string {
  return (input || '').replace(/\D/g, '');
}

export function isValidDeviceId(input: string): boolean {
  const id = normalizeDeviceId(input);
  if (id.length !== DEVICE_ID_LENGTH || id[0] === '0') return false;
  return luhnCheckDigit(id.slice(0, -1)) === Number(id[id.length - 1]);
}

export function formatDeviceId(input: string): string {
  const id = normalizeDeviceId(input);
  return id.replace(/(\d{3})(?=\d)/g, '$1 ').trim();
}

export function randomToken(bytes = 32): string {
  return toHex(randomBytes(bytes));
}

export function uuid(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
