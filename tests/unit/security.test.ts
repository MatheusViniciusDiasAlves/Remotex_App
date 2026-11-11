import { describe, expect, it } from 'vitest';
import { LockoutTracker, SlidingWindowLimiter } from '@remotex/security/rate-limiter';
import { DEFAULT_GRANT, intersect, permissionSet, sanitizePermissions } from '@remotex/security/permissions';
import { checkAccessPassword, clampString } from '@remotex/security/validation';

describe('SlidingWindowLimiter', () => {
  it('bloqueia acima do limite e libera após a janela', () => {
    let now = 0;
    const l = new SlidingWindowLimiter(3, 1000, () => now);
    expect([l.hit('k'), l.hit('k'), l.hit('k'), l.hit('k')]).toEqual([true, true, true, false]);
    expect(l.hit('outra')).toBe(true);
    now = 1001;
    expect(l.hit('k')).toBe(true);
  });
});

describe('LockoutTracker (força bruta)', () => {
  it('bloqueia após N falhas com tempo exponencial', () => {
    let now = 0;
    const t = new LockoutTracker(3, 1000, 10_000, () => now);
    expect(t.fail('h')).toBe(0);
    expect(t.fail('h')).toBe(0);
    expect(t.fail('h')).toBe(1000);
    now = 1500;
    expect(t.isLocked('h')).toBe(0);
    expect(t.fail('h')).toBe(2000);
    expect(t.fail('h')).toBe(4000);
    t.success('h');
    expect(t.isLocked('h')).toBe(0);
  });
  it('respeita o máximo', () => {
    const t = new LockoutTracker(1, 1000, 5000, () => 0);
    for (let i = 0; i < 20; i++) t.fail('x');
    expect(t.isLocked('x')).toBe(5000);
  });
});

describe('permissões', () => {
  it('view é sempre verdadeiro e interseção funciona', () => {
    const p = permissionSet({ control: true });
    expect(p.view).toBe(true);
    expect(p.keyboard).toBe(false);
    const eff = intersect(DEFAULT_GRANT, { control: true, keyboard: false, admin: true });
    expect(eff.control).toBe(true);
    expect(eff.keyboard).toBe(false);
    expect(eff.admin).toBe(false);
  });
  it('sanitiza entrada não confiável', () => {
    const p = sanitizePermissions({ control: 'yes', keyboard: true, hack: true });
    expect(p.control).toBe(false);
    expect(p.keyboard).toBe(true);
    expect((p as any).hack).toBeUndefined();
  });
});

describe('validação', () => {
  it('regras de senha', () => {
    expect(checkAccessPassword('curta')).not.toBeNull();
    expect(checkAccessPassword('somenteletras')).not.toBeNull();
    expect(checkAccessPassword('Senha-Forte-2026')).toBeNull();
  });
  it('remove controles e limita tamanho', () => {
    expect(clampString('a\u0000b\nc', 10)).toBe('abc');
    expect(clampString('x'.repeat(50), 5)).toBe('xxxxx');
  });
});
