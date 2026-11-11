/** Testa o injetor XTest contra um servidor X real (Xvfb). Requer DISPLAY. */
import { afterAll, describe, expect, it } from 'vitest';
import { LinuxX11Injector } from '@remotex/input/linux-injector';

describe.runIf(Boolean(process.env.DISPLAY))('LinuxX11Injector', () => {
  const inj = new LinuxX11Injector();
  afterAll(() => inj.dispose());

  it('move o cursor real do servidor X', () => {
    inj.moveTo(123, 456);
    expect(inj.cursorPosition()).toEqual({ x: 123, y: 456 });
    inj.moveTo(10, 20);
    expect(inj.cursorPosition()).toEqual({ x: 10, y: 20 });
  });

  it('teclas conhecidas e texto com acentos não falham', () => {
    expect(inj.key('KeyA', true).ok).toBe(true);
    expect(inj.key('KeyA', false).ok).toBe(true);
    expect(inj.key('NaoExiste', true).ok).toBe(false);
    expect(inj.typeText('Olá ç €').ok).toBe(true);
  });
});
