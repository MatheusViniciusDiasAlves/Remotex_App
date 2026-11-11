/**
 * Injeção de entrada em Linux/X11 via extensão XTest (libXtst), por FFI (koffi).
 * Usado para hosts Linux e para os testes ponta a ponta automatizados sob Xvfb.
 * Caracteres fora do mapa de teclado atual (ex.: "ç", "á", emojis) são digitados remapeando
 * temporariamente um keycode livre, como faz o xdotool.
 */
import * as koffi from 'koffi';
import type { MouseButton } from '@remotex/media/channel-protocol';
import type { InjectResult, InputInjector } from './injector';
import { keyDef } from './keymap';

const XK_Shift_L = 0xffe1;

/** Caracteres do português pré-mapeados em keycodes livres (evita corrida no 1º uso). */
const PREMAPPED = 'áéíóúãõâêôçà';

/** Pausa síncrona curta (o mapa de teclado precisa chegar ao aplicativo antes da tecla). */
function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class LinuxX11Injector implements InputInjector {
  readonly name = 'linux-xtest';
  private x11 = koffi.load('libX11.so.6');
  private xtst = koffi.load('libXtst.so.6');
  private XOpenDisplay = this.x11.func('void *XOpenDisplay(const char *name)');
  private XCloseDisplay = this.x11.func('int XCloseDisplay(void *dpy)');
  private XFlush = this.x11.func('int XFlush(void *dpy)');
  private XSync = this.x11.func('int XSync(void *dpy, int discard)');
  private XKeysymToKeycode = this.x11.func('uint8_t XKeysymToKeycode(void *dpy, unsigned long keysym)');
  private XDisplayKeycodes = this.x11.func('int XDisplayKeycodes(void *dpy, _Out_ int *min, _Out_ int *max)');
  private XGetKeyboardMapping = this.x11.func('void *XGetKeyboardMapping(void *dpy, uint8_t first, int count, _Out_ int *per)');
  private XChangeKeyboardMapping = this.x11.func('int XChangeKeyboardMapping(void *dpy, int first, int per, unsigned long *syms, int num)');
  private XFree = this.x11.func('int XFree(void *data)');
  private XDefaultRootWindow = this.x11.func('unsigned long XDefaultRootWindow(void *dpy)');
  private XQueryPointer = this.x11.func(
    'int XQueryPointer(void *dpy, unsigned long w, _Out_ unsigned long *root, _Out_ unsigned long *child, _Out_ int *rx, _Out_ int *ry, _Out_ int *wx, _Out_ int *wy, _Out_ unsigned int *mask)',
  );
  private XTestFakeMotionEvent = this.xtst.func('int XTestFakeMotionEvent(void *dpy, int screen, int x, int y, unsigned long delay)');
  private XTestFakeButtonEvent = this.xtst.func('int XTestFakeButtonEvent(void *dpy, unsigned int button, int press, unsigned long delay)');
  private XTestFakeKeyEvent = this.xtst.func('int XTestFakeKeyEvent(void *dpy, unsigned int keycode, int press, unsigned long delay)');

  private dpy: unknown;
  private minKc = 8;
  private maxKc = 255;
  private per = 1;
  private mapping: number[] = [];
  private spareKeycode = 0;
  /** Keycodes sem símbolo usados em rodízio para caracteres fora do layout atual. */
  private spares: number[] = [];
  private nextSpare = 0;
  private assigned = new Map<number, number>(); // keysym → keycode livre remapeado
  private dynamicFrom = 0;

  constructor(displayName: string | null = null) {
    this.dpy = this.XOpenDisplay(displayName);
    if (!this.dpy) throw new Error(`Não foi possível abrir o display X11 ${displayName ?? process.env.DISPLAY ?? ''}`);
    this.loadMapping();
  }

  private loadMapping(): void {
    const min = [0];
    const max = [0];
    this.XDisplayKeycodes(this.dpy, min, max);
    this.minKc = min[0];
    this.maxKc = max[0];
    const per = [0];
    const count = this.maxKc - this.minKc + 1;
    const ptr = this.XGetKeyboardMapping(this.dpy, this.minKc, count, per);
    this.per = per[0];
    // koffi devolve unsigned long (64 bits) como BigUint64Array: converte para number.
    const raw = koffi.decode(ptr, 'unsigned long', count * this.per) as ArrayLike<number | bigint>;
    this.mapping = Array.from(raw, (v) => Number(v));
    this.XFree(ptr);
    // keycodes livres (sem nenhum símbolo) para remapear caracteres especiais
    for (let kc = this.maxKc; kc >= this.minKc; kc--) {
      if (this.symsOf(kc).every((s) => s === 0)) this.spares.push(kc);
    }
    this.spareKeycode = this.spares[0] ?? 0;
    // Pré-mapeia acentos comuns; os keycodes restantes ficam para remapeamento dinâmico.
    if (this.spares.length > 4) {
      const pre = Array.from(PREMAPPED).slice(0, this.spares.length - 4);
      pre.forEach((ch, i) => {
        const sym = ch.codePointAt(0)!;
        const kc = this.spares[i];
        this.XChangeKeyboardMapping(this.dpy, kc, 2, [sym, sym], 1);
        this.assigned.set(sym, kc);
      });
      this.dynamicFrom = pre.length;
      this.XSync(this.dpy, 0);
    }
  }

  private symsOf(kc: number): number[] {
    const i = (kc - this.minKc) * this.per;
    return this.mapping.slice(i, i + this.per);
  }

  private flush(): InjectResult {
    this.XFlush(this.dpy);
    return { ok: true };
  }

  moveTo(x: number, y: number): InjectResult {
    this.XTestFakeMotionEvent(this.dpy, -1, Math.round(x), Math.round(y), 0);
    return this.flush();
  }

  button(b: MouseButton, down: boolean): InjectResult {
    const xb = b === 0 ? 1 : b === 1 ? 2 : 3;
    this.XTestFakeButtonEvent(this.dpy, xb, down ? 1 : 0, 0);
    return this.flush();
  }

  wheel(dx: number, dy: number): InjectResult {
    // X11 não tem roda de alta resolução via XTest: 1 clique por 120 unidades (mínimo 1).
    const clicks = (v: number) => (v === 0 ? 0 : Math.max(1, Math.round(Math.abs(v) / 120)));
    for (let i = 0; i < clicks(dy); i++) this.clickButton(dy > 0 ? 5 : 4);
    for (let i = 0; i < clicks(dx); i++) this.clickButton(dx > 0 ? 7 : 6);
    return this.flush();
  }

  private clickButton(xb: number): void {
    this.XTestFakeButtonEvent(this.dpy, xb, 1, 0);
    this.XTestFakeButtonEvent(this.dpy, xb, 0, 0);
  }

  key(code: string, down: boolean): InjectResult {
    const def = keyDef(code);
    if (!def) return { ok: false };
    const kc = this.XKeysymToKeycode(this.dpy, def.x11) as number;
    if (!kc) return { ok: false };
    this.XTestFakeKeyEvent(this.dpy, kc, down ? 1 : 0, 0);
    return this.flush();
  }

  /**
   * Usa um keycode livre diferente para cada caractere novo (rodízio). Reutilizar o mesmo keycode
   * em sequência causa troca de caracteres, pois o aplicativo traduz a tecla com o mapa já alterado.
   */
  private spareFor(keysym: number): number {
    const cached = this.assigned.get(keysym);
    if (cached) return cached;
    const dyn = this.spares.slice(this.dynamicFrom);
    if (!dyn.length) return 0;
    const kc = dyn[this.nextSpare % dyn.length];
    this.nextSpare++;
    for (const [sym, code] of this.assigned) if (code === kc) this.assigned.delete(sym);
    this.XChangeKeyboardMapping(this.dpy, kc, 2, [keysym, keysym], 1);
    this.XSync(this.dpy, 0);
    syncSleep(30);
    this.assigned.set(keysym, kc);
    return kc;
  }

  typeText(text: string): InjectResult {
    for (const ch of Array.from(text)) {
      const cp = ch.codePointAt(0)!;
      const keysym = ch === '\n' ? 0xff0d : ch === '\t' ? 0xff09 : cp < 0x100 ? cp : 0x01000000 | cp;
      let kc = this.assigned.get(keysym) ?? (this.XKeysymToKeycode(this.dpy, keysym) as number);
      let shift = false;
      if (kc && !this.assigned.has(keysym)) {
        const syms = this.symsOf(kc);
        if (syms[0] === keysym) shift = false;
        else if (syms[1] === keysym) shift = true;
        else kc = 0; // apenas em níveis AltGr — usa remapeamento
      }
      if (!kc) kc = this.spareFor(keysym);
      if (!kc) continue;
      const shiftKc = shift ? (this.XKeysymToKeycode(this.dpy, XK_Shift_L) as number) : 0;
      if (shiftKc) this.XTestFakeKeyEvent(this.dpy, shiftKc, 1, 0);
      this.XTestFakeKeyEvent(this.dpy, kc, 1, 0);
      this.XTestFakeKeyEvent(this.dpy, kc, 0, 0);
      if (shiftKc) this.XTestFakeKeyEvent(this.dpy, shiftKc, 0, 0);
    }
    return this.flush();
  }

  cursorPosition(): { x: number; y: number } | null {
    const root = [0], child = [0], rx = [0], ry = [0], wx = [0], wy = [0], mask = [0];
    const ok = this.XQueryPointer(this.dpy, this.XDefaultRootWindow(this.dpy), root, child, rx, ry, wx, wy, mask);
    return ok ? { x: rx[0], y: ry[0] } : null;
  }

  caretActive(): boolean | null {
    return null;
  }

  dispose(): void {
    if (this.dpy) {
      for (const kc of new Set(this.assigned.values())) this.XChangeKeyboardMapping(this.dpy, kc, 2, [0, 0], 1);
      this.XSync(this.dpy, 0);
      this.XCloseDisplay(this.dpy);
    }
    this.dpy = null;
  }
}
