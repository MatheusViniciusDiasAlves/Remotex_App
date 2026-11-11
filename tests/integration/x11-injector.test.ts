/** Testa o injetor XTest contra um servidor X real (Xvfb). Requer DISPLAY. */
import { afterAll, describe, expect, it } from 'vitest';
import { LinuxX11Injector } from '@remotex/input/linux-injector';

function tryOpen(): LinuxX11Injector | null {
  if (!process.env.DISPLAY) return null;
  try {
    return new LinuxX11Injector();
  } catch {
    return null;
  }
}
const opened = tryOpen();

describe.runIf(opened !== null)('LinuxX11Injector', () => {
  const inj = opened!;
  afterAll(() => inj.dispose());

  it('move o cursor real do servidor X', () => {
    inj.moveTo(123, 456);
    expect(inj.cursorPosition()).toEqual({ x: 123, y: 456 });
    inj.moveTo(10, 20);
    expect(inj.cursorPosition()).toEqual({ x: 10, y: 20 });
  });

  it('lê o mapa de teclado do servidor X como números', () => {
    const m = (inj as any).mapping as number[];
    expect(m.length).toBeGreaterThan(100);
    expect(typeof m[0]).toBe('number');
    expect((inj as any).spareKeycode).toBeGreaterThan(0);
  });

  it('teclas conhecidas e texto com acentos não falham', () => {
    expect(inj.key('KeyA', true).ok).toBe(true);
    expect(inj.key('KeyA', false).ok).toBe(true);
    expect(inj.key('NaoExiste', true).ok).toBe(false);
    expect(inj.typeText('Olá ç €').ok).toBe(true);
  });
});
