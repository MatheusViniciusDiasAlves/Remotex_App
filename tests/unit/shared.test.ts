import { describe, expect, it } from 'vitest';
import { fromBase64Url, fromHex, toBase64Url, toHex, utf8, constantTimeEqual } from '@remotex/shared/encoding';
import { formatDeviceId, generateDeviceId, isValidDeviceId, normalizeDeviceId, uuid } from '@remotex/shared/ids';
import { Emitter } from '@remotex/shared/emitter';

describe('encoding', () => {
  it('hex ida e volta', () => {
    const b = new Uint8Array([0, 1, 127, 128, 255]);
    expect(toHex(b)).toBe('00017f80ff');
    expect([...fromHex('00017f80ff')]).toEqual([...b]);
    expect(() => fromHex('abc')).toThrow();
  });
  it('base64url compatível com Buffer', () => {
    for (let n = 0; n < 40; n++) {
      const b = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
      const ours = toBase64Url(b);
      expect(ours).toBe(Buffer.from(b).toString('base64url'));
      expect([...fromBase64Url(ours)]).toEqual([...b]);
    }
  });
  it('comparação em tempo constante', () => {
    expect(constantTimeEqual(utf8('abc'), utf8('abc'))).toBe(true);
    expect(constantTimeEqual(utf8('abc'), utf8('abd'))).toBe(false);
    expect(constantTimeEqual(utf8('abc'), utf8('ab'))).toBe(false);
  });
});

describe('IDs de dispositivo', () => {
  it('gera IDs de 9 dígitos válidos com dígito verificador', () => {
    for (let i = 0; i < 200; i++) {
      const id = generateDeviceId();
      expect(id).toMatch(/^[1-9]\d{8}$/);
      expect(isValidDeviceId(id)).toBe(true);
    }
  });
  it('detecta erro de digitação (um dígito trocado)', () => {
    const id = generateDeviceId();
    const wrong = id.slice(0, 4) + String((Number(id[4]) + 1) % 10) + id.slice(5);
    expect(isValidDeviceId(wrong)).toBe(false);
  });
  it('formata e normaliza', () => {
    expect(formatDeviceId('123456789')).toBe('123 456 789');
    expect(normalizeDeviceId(' 123-456 789 ')).toBe('123456789');
  });
  it('uuid v4', () => {
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('Emitter', () => {
  it('on/once/off', () => {
    const e = new Emitter<{ a: number }>();
    const got: number[] = [];
    const off = e.on('a', (n) => got.push(n));
    e.once('a', (n) => got.push(n * 10));
    e.emit('a', 1);
    e.emit('a', 2);
    off();
    e.emit('a', 3);
    expect(got).toEqual([1, 10, 2]);
  });
});
