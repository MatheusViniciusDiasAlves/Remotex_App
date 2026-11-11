/**
 * Valida a estrutura binária INPUT usada com SendInput sem precisar do Windows: os tipos usam
 * tamanhos explícitos, então o layout x64 é idêntico no Linux. Usamos memcpy da libc para
 * serializar um array JS de INPUT exatamente como o koffi o entregaria ao user32.dll.
 */
import { describe, expect, it } from 'vitest';
import * as koffi from 'koffi';
import { INPUT, keyInput, mouseInput, textToInputs, wheelInputs, REMOTEX_EXTRA_INFO } from '@remotex/input/windows-injector';

const isX64 = process.arch === 'x64' && process.platform === 'linux';

describe.runIf(isX64)('estruturas do SendInput (x64)', () => {
  it('sizeof(INPUT) = 40 bytes como no Windows x64', () => {
    expect(koffi.sizeof(INPUT)).toBe(40);
  });

  it('serializa teclado e mouse com os offsets corretos', () => {
    const libc = koffi.load('libc.so.6');
    const memcpy = libc.func('void *memcpy(_Out_ uint8_t *dst, RX_INPUT *src, size_t n)');
    const inputs = [keyInput(0, 0x00e7, 0x0004), mouseInput(0x8001 | 0x4000, 32767, 100, 0), ...wheelInputs(0, 240)];
    const out = new Uint8Array(40 * inputs.length);
    memcpy(out, inputs, out.length);
    const dv = new DataView(out.buffer);
    // INPUT[0]: teclado — type=1, ki.wVk=0, ki.wScan='ç', dwFlags=UNICODE
    expect(dv.getUint32(0, true)).toBe(1);
    expect(dv.getUint16(8, true)).toBe(0);
    expect(dv.getUint16(10, true)).toBe(0xe7);
    expect(dv.getUint32(12, true)).toBe(4);
    expect(Number(dv.getBigUint64(24, true))).toBe(REMOTEX_EXTRA_INFO);
    // INPUT[1]: mouse — type=0, dx, dy, flags
    expect(dv.getUint32(40, true)).toBe(0);
    expect(dv.getInt32(48, true)).toBe(32767);
    expect(dv.getInt32(52, true)).toBe(100);
    expect(dv.getUint32(60, true)).toBe(0xc001);
    // INPUT[2]: roda — mouseData negativo (rolar para baixo)
    expect(dv.getInt32(80 + 16, true)).toBe(-240);
    expect(dv.getUint32(80 + 20, true)).toBe(0x0800);
  });

  it('texto Unicode vira pares keydown/keyup com KEYEVENTF_UNICODE; \\n vira Enter', () => {
    const ins = textToInputs('é\n');
    expect(ins).toHaveLength(4);
    expect(ins[0].u.ki).toMatchObject({ wVk: 0, wScan: 0xe9, dwFlags: 4 });
    expect(ins[1].u.ki).toMatchObject({ wScan: 0xe9, dwFlags: 6 });
    expect(ins[2].u.ki).toMatchObject({ wVk: 0x0d, dwFlags: 0 });
    expect(textToInputs('👍')).toHaveLength(4); // par substituto UTF-16
  });
});
