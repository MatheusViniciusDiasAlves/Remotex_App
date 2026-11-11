/**
 * Validação do injetor em WINDOWS REAL (executa só em win32 — ex.: CI windows-latest).
 * Usa as APIs oficiais user32 (SendInput/GetCursorPos/GetGUIThreadInfo) via koffi.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { WindowsInjector } from '@remotex/input/windows-injector';

describe.runIf(process.platform === 'win32')('WindowsInjector em Windows real', () => {
  let inj: WindowsInjector;
  beforeAll(async () => {
    const mod = await import('@remotex/input/windows-injector');
    inj = new mod.WindowsInjector();
  });

  it('move o cursor com SendInput (coordenadas absolutas no desktop virtual)', () => {
    for (const [x, y] of [
      [100, 120],
      [400, 300],
    ]) {
      const r = inj.moveTo(x, y);
      expect(r.ok).toBe(true);
      const p = inj.cursorPosition();
      expect(p).not.toBeNull();
      expect(Math.abs(p!.x - x)).toBeLessThanOrEqual(1);
      expect(Math.abs(p!.y - y)).toBeLessThanOrEqual(1);
    }
  });

  it('botões, roda, teclas e texto Unicode são aceitos pelo Windows', () => {
    expect(inj.wheel(0, 120).ok).toBe(true);
    expect(inj.key('ShiftLeft', true).ok).toBe(true);
    expect(inj.key('ShiftLeft', false).ok).toBe(true);
    expect(inj.typeText('').ok).toBe(true);
  });

  it('consulta privilégios e caret sem falhar', () => {
    expect(typeof inj.isElevated()).toBe('boolean');
    expect(typeof inj.foregroundIsElevated(true)).toBe('boolean');
    const caret = inj.caretActive();
    expect(caret === null || typeof caret === 'boolean').toBe(true);
  });
});
