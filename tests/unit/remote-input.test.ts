import { describe, expect, it } from 'vitest';
import { InputDispatcher } from '@remotex/input/input-dispatcher';
import { RecordingInjector } from '@remotex/input/injector';
import { charToCode, keyDef, KEYMAP } from '@remotex/input/keymap';
import { diffText } from '@remotex/input/text-diff';
import { touchpadDelta } from '@remotex/input/touchpad';
import { GestureRecognizer, type Timer } from '@remotex/input/gestures';
import { DEFAULT_GRANT, permissionSet } from '@remotex/security/permissions';
import { normalizedToDesktop, toWindowsAbsolute, desktopToNormalized } from '@remotex/capture/geometry';

const display = { x: 1920, y: 0, width: 2560, height: 1440 };

function make(perms = DEFAULT_GRANT) {
  const inj = new RecordingInjector();
  let blocked = 0;
  const d = new InputDispatcher({ injector: inj, getDisplayRect: () => display, getPermissions: () => perms, onBlocked: () => blocked++ });
  return { inj, d, blocked: () => blocked };
}

describe('geometria', () => {
  it('normalizado → desktop com segundo monitor', () => {
    expect(normalizedToDesktop(0, 0, display)).toEqual({ x: 1920, y: 0 });
    expect(normalizedToDesktop(1, 1, display)).toEqual({ x: 1920 + 2559, y: 1439 });
    expect(normalizedToDesktop(0.5, 0.5, display)).toEqual({ x: 1920 + 1280, y: 720 });
    expect(normalizedToDesktop(-3, 9, display)).toEqual({ x: 1920, y: 1439 });
  });
  it('coordenadas absolutas do SendInput (0..65535 no desktop virtual)', () => {
    const vs = { x: -1920, y: 0, width: 1920 + 2560, height: 1440 };
    expect(toWindowsAbsolute(-1920, 0, vs)).toEqual({ dx: 0, dy: 0 });
    expect(toWindowsAbsolute(2559, 1439, vs)).toEqual({ dx: 65535, dy: 65535 });
  });
  it('desktop → normalizado', () => {
    const n = desktopToNormalized(1920 + 1280, 720, display);
    expect(n.inside).toBe(true);
    expect(n.x).toBeCloseTo(0.5, 2);
  });
});

describe('InputDispatcher', () => {
  it('clique leva o cursor à posição antes de pressionar', () => {
    const { inj, d } = make();
    expect(d.handle({ k: 'click', b: 0, x: 0.5, y: 0.5, n: 2, s: 1 }).ok).toBe(true);
    expect(inj.calls).toEqual([
      ['move', 3200, 720],
      ['button', 0, true],
      ['button', 0, false],
      ['button', 0, true],
      ['button', 0, false],
    ]);
  });
  it('descarta movimentos atrasados em relação a cliques', () => {
    const { inj, d } = make();
    d.handle({ k: 'btn', b: 0, down: true, x: 0.1, y: 0.1, s: 10 });
    expect(d.handle({ k: 'mv', x: 0.9, y: 0.9, s: 9 }).reason).toBe('stale');
    expect(d.handle({ k: 'mv', x: 0.2, y: 0.2, s: 11 }).ok).toBe(true);
    expect(d.handle({ k: 'mv', x: 0.3, y: 0.3, s: 11 }).reason).toBe('stale');
    expect(inj.calls.filter((c) => c[0] === 'move').length).toBe(2);
  });
  it('respeita permissões', () => {
    const { inj, d } = make(permissionSet({ control: true, keyboard: false }));
    expect(d.handle({ k: 'text', text: 'oi' }).reason).toBe('forbidden');
    expect(d.handle({ k: 'key', code: 'KeyA', down: true }).reason).toBe('forbidden');
    const v = make(permissionSet({}));
    expect(v.d.handle({ k: 'mv', x: 0.1, y: 0.1, s: 1 }).reason).toBe('forbidden');
    expect(inj.calls).toEqual([]);
  });
  it('combo pressiona em ordem e solta em ordem inversa', () => {
    const { inj, d } = make();
    d.handle({ k: 'combo', codes: ['ControlLeft', 'ShiftLeft', 'Escape'] });
    expect(inj.calls.map((c) => `${c[1]}${c[2] ? '↓' : '↑'}`)).toEqual([
      'ControlLeft↓', 'ShiftLeft↓', 'Escape↓', 'Escape↑', 'ShiftLeft↑', 'ControlLeft↑',
    ]);
  });
  it('rejeita teclas desconhecidas e texto gigante', () => {
    const { d } = make();
    expect(d.handle({ k: 'key', code: 'Bogus', down: true }).reason).toBe('unknown-key');
    expect(d.handle({ k: 'text', text: 'x'.repeat(5000) }).reason).toBe('invalid');
  });
  it('libera teclas e botões presos', () => {
    const { inj, d } = make();
    d.handle({ k: 'key', code: 'ControlLeft', down: true });
    d.handle({ k: 'btn', b: 0, down: true, x: 0, y: 0, s: 1 });
    inj.calls = [];
    d.releaseAll();
    expect(inj.calls).toEqual([
      ['key', 'ControlLeft', false],
      ['button', 0, false],
    ]);
    expect(d.pressedKeys).toEqual([]);
  });
  it('notifica bloqueio por UIPI (janela elevada)', () => {
    const { inj, d, blocked } = make();
    inj.blockAll = true;
    expect(d.handle({ k: 'text', text: 'a' }).reason).toBe('blocked');
    expect(blocked()).toBe(1);
  });
  it('limita roda do mouse', () => {
    const { inj, d } = make();
    d.handle({ k: 'wheel', dx: 0, dy: 1e9, x: 0.5, y: 0.5 });
    expect(inj.calls.at(-1)).toEqual(['wheel', 0, 3600]);
  });
});

describe('keymap', () => {
  it('cobre teclas especiais exigidas', () => {
    for (const c of ['Escape', 'Tab', 'ControlLeft', 'AltLeft', 'ShiftLeft', 'MetaLeft', 'Delete', 'Enter', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']) {
      expect(keyDef(c), c).toBeDefined();
    }
    for (let i = 1; i <= 12; i++) expect(KEYMAP[`F${i}`].vk).toBe(0x6f + i);
    expect(KEYMAP.KeyA.vk).toBe(0x41);
    expect(KEYMAP.ArrowLeft.ext).toBe(true);
  });
  it('caractere → código físico', () => {
    expect(charToCode('c')).toBe('KeyC');
    expect(charToCode('V')).toBe('KeyV');
    expect(charToCode('5')).toBe('Digit5');
    expect(charToCode('é')).toBeUndefined();
  });
});

describe('diferença de texto do teclado nativo', () => {
  it('digitação normal envia só o novo caractere', () => {
    expect(diffText('hel', 'hell')).toEqual({ backspaces: 0, insert: 'l' });
  });
  it('autocorreção substitui o final', () => {
    expect(diffText('teh', 'the ')).toEqual({ backspaces: 2, insert: 'he ' });
  });
  it('apagar', () => {
    expect(diffText('abc', 'ab')).toEqual({ backspaces: 1, insert: '' });
  });
  it('acentos e emoji contam como um caractere', () => {
    expect(diffText('ação', 'ação 👍')).toEqual({ backspaces: 0, insert: ' 👍' });
    expect(diffText('ok 👍', 'ok ')).toEqual({ backspaces: 1, insert: '' });
  });
});

describe('touchpad', () => {
  it('movimento rápido acelera mais que lento', () => {
    const remote = { width: 1920, height: 1080 };
    const slow = touchpadDelta(10, 0, 100, remote);
    const fast = touchpadDelta(10, 0, 5, remote);
    expect(fast.dx).toBeGreaterThan(slow.dx);
    expect(slow.dx).toBeGreaterThan(0);
  });
});

describe('GestureRecognizer', () => {
  function setup() {
    const timers: Array<{ fn: () => void; at: number; cancelled: boolean }> = [];
    let now = 0;
    const timer: Timer = (fn, ms) => {
      const t = { fn, at: now + ms, cancelled: false };
      timers.push(t);
      return () => (t.cancelled = true);
    };
    const advance = (ms: number) => {
      now += ms;
      for (const t of timers) if (!t.cancelled && t.at <= now) {
        t.cancelled = true;
        t.fn();
      }
    };
    const ev: string[] = [];
    const g = new GestureRecognizer(
      {
        tap: (p, n) => ev.push(`tap${n}@${p.x},${p.y}`),
        twoFingerTap: () => ev.push('tap2f'),
        longPress: () => ev.push('long'),
        dragStart: (_p, k) => ev.push(`dragStart:${k}`),
        dragMove: (p) => ev.push(`drag@${p.x},${p.y}`),
        dragEnd: (_p, k) => ev.push(`dragEnd:${k}`),
        scroll: (dx, dy) => ev.push(`scroll:${dx},${dy}`),
        pinch: (s) => ev.push(`pinch:${s.toFixed(2)}`),
        pinchEnd: () => ev.push('pinchEnd'),
        pan: (d) => ev.push(`pan:${d.x},${d.y}`),
      },
      undefined,
      timer,
    );
    return { g, ev, advance, now: () => now };
  }

  it('toque simples e duplo', () => {
    const { g, ev, advance, now } = setup();
    g.down(1, { x: 10, y: 10 }, now());
    advance(80);
    g.up(1, { x: 11, y: 10 }, now());
    advance(120);
    g.down(1, { x: 12, y: 11 }, now());
    advance(80);
    g.up(1, { x: 12, y: 11 }, now());
    expect(ev).toEqual(['tap1@10,10', 'tap2@12,11']);
  });
  it('toque prolongado', () => {
    const { g, ev, advance, now } = setup();
    g.down(1, { x: 10, y: 10 }, now());
    advance(600);
    g.up(1, { x: 10, y: 10 }, now());
    expect(ev).toEqual(['long']);
  });
  it('arrastar com um dedo', () => {
    const { g, ev, advance, now } = setup();
    g.down(1, { x: 0, y: 0 }, now());
    advance(50);
    g.move(1, { x: 30, y: 0 }, now());
    g.move(1, { x: 60, y: 0 }, now());
    g.up(1, { x: 60, y: 0 }, now());
    expect(ev).toEqual(['dragStart:drag', 'drag@30,0', 'drag@60,0', 'dragEnd:drag']);
  });
  it('toque + arrastar = tap-drag; prolongado + arrastar = long-drag', () => {
    const { g, ev, advance, now } = setup();
    g.down(1, { x: 0, y: 0 }, now());
    advance(50);
    g.up(1, { x: 0, y: 0 }, now());
    advance(100);
    g.down(1, { x: 2, y: 2 }, now());
    g.move(1, { x: 40, y: 2 }, now());
    g.up(1, { x: 40, y: 2 }, now());
    advance(1000);
    g.down(1, { x: 0, y: 0 }, now());
    advance(600);
    g.move(1, { x: 50, y: 0 }, now());
    g.up(1, { x: 50, y: 0 }, now());
    expect(ev).toEqual(['tap1@0,0', 'dragStart:tap-drag', 'drag@40,2', 'dragEnd:tap-drag', 'long', 'dragStart:long-drag', 'drag@50,0', 'dragEnd:long-drag']);
  });
  it('dois dedos: toque, rolagem e pinça', () => {
    const { g, ev, advance, now } = setup();
    g.down(1, { x: 100, y: 100 }, now());
    g.down(2, { x: 200, y: 100 }, now());
    advance(100);
    g.up(1, { x: 100, y: 100 }, now());
    g.up(2, { x: 200, y: 100 }, now());
    expect(ev).toEqual(['tap2f']);
    ev.length = 0;
    g.down(1, { x: 100, y: 100 }, now());
    g.down(2, { x: 200, y: 100 }, now());
    g.move(1, { x: 100, y: 120 }, now());
    g.move(2, { x: 200, y: 120 }, now());
    g.up(1, { x: 100, y: 120 }, now());
    g.up(2, { x: 200, y: 120 }, now());
    expect(ev[0]).toBe('scroll:0,20');
    ev.length = 0;
    g.down(1, { x: 100, y: 100 }, now());
    g.down(2, { x: 200, y: 100 }, now());
    g.move(2, { x: 260, y: 100 }, now());
    g.move(2, { x: 300, y: 100 }, now());
    g.up(2, { x: 300, y: 100 }, now());
    g.up(1, { x: 100, y: 100 }, now());
    expect(ev).toEqual(['pinch:1.25', 'pinchEnd']);
  });
  it('três dedos movimentam a imagem', () => {
    const { g, ev, now } = setup();
    g.down(1, { x: 0, y: 0 }, now());
    g.down(2, { x: 10, y: 0 }, now());
    g.down(3, { x: 20, y: 0 }, now());
    g.move(1, { x: 30, y: 0 }, now());
    expect(ev).toEqual(['pan:10,0']);
  });
});
