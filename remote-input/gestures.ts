/**
 * Reconhecedor de gestos de toque (independente do DOM para poder ser testado).
 *
 * Gestos reconhecidos:
 *  - toque simples / duplo (tap, com contagem)          → clique / duplo clique
 *  - toque prolongado (longPress)                       → clique direito (TOUCH) / arrastar (MOUSE)
 *  - arrastar com 1 dedo (drag: 'drag' | 'long-drag' | 'tap-drag')
 *  - toque com 2 dedos (twoFingerTap)                   → clique direito
 *  - 2 dedos movendo juntos (scroll)                    → rolagem vertical/horizontal
 *  - pinça (pinch)                                      → zoom + movimentação da imagem
 *  - 3 dedos (pan)                                      → movimentar a imagem ampliada
 *
 * A interpretação (o que cada gesto faz no PC) fica com o controlador da sessão, de acordo com
 * o modo TOUCH ou MOUSE.
 */
export interface Pt {
  x: number;
  y: number;
}

export interface GestureConfig {
  slop: number;
  longPressMs: number;
  doubleTapMs: number;
  doubleTapSlop: number;
  multiTapMs: number;
  pinchThreshold: number;
  scrollThreshold: number;
}

export const DEFAULT_GESTURES: GestureConfig = {
  slop: 10,
  longPressMs: 550,
  doubleTapMs: 320,
  doubleTapSlop: 30,
  multiTapMs: 280,
  pinchThreshold: 28,
  scrollThreshold: 10,
};

export type DragKind = 'drag' | 'long-drag' | 'tap-drag';

export interface GestureHandlers {
  tap?(p: Pt, count: number): void;
  twoFingerTap?(p: Pt): void;
  longPress?(p: Pt): void;
  dragStart?(p: Pt, kind: DragKind): void;
  dragMove?(p: Pt, delta: Pt, dtMs: number): void;
  dragEnd?(p: Pt, kind: DragKind): void;
  scroll?(dx: number, dy: number, center: Pt): void;
  scrollEnd?(): void;
  pinch?(scale: number, center: Pt, pan: Pt): void;
  pinchEnd?(): void;
  pan?(delta: Pt): void;
  touchStart?(p: Pt): void;
}

export type Timer = (fn: () => void, ms: number) => () => void;

const defaultTimer: Timer = (fn, ms) => {
  const h = setTimeout(fn, ms);
  return () => clearTimeout(h);
};

type State = 'idle' | 'pending1' | 'longpressed' | 'drag1' | 'pending2' | 'scroll' | 'pinch' | 'pan3' | 'done';

export class GestureRecognizer {
  private pointers = new Map<number, Pt>();
  private state: State = 'idle';
  private start: Pt = { x: 0, y: 0 };
  private startTime = 0;
  private last: Pt = { x: 0, y: 0 };
  private lastTime = 0;
  private cancelLong: (() => void) | null = null;
  private dragKind: DragKind = 'drag';
  private lastTap: { p: Pt; t: number; count: number } | null = null;
  private afterTap = false;
  private multiStart = 0;
  private maxPointers = 0;
  private multiMoved = false;
  private dist0 = 0;
  private prevDist = 0;
  private center0: Pt = { x: 0, y: 0 };
  private prevCenter: Pt = { x: 0, y: 0 };

  constructor(
    private readonly handlers: GestureHandlers,
    private readonly cfg: GestureConfig = DEFAULT_GESTURES,
    private readonly timer: Timer = defaultTimer,
  ) {}

  get currentState(): string {
    return this.state;
  }

  down(id: number, p: Pt, t: number): void {
    this.pointers.set(id, { ...p });
    this.maxPointers = Math.max(this.maxPointers, this.pointers.size);
    const n = this.pointers.size;
    if (n === 1) {
      this.state = 'pending1';
      this.start = { ...p };
      this.last = { ...p };
      this.startTime = t;
      this.lastTime = t;
      this.maxPointers = 1;
      this.multiMoved = false;
      this.afterTap = Boolean(
        this.lastTap && t - this.lastTap.t <= this.cfg.doubleTapMs && dist(this.lastTap.p, p) <= this.cfg.doubleTapSlop,
      );
      this.handlers.touchStart?.(p);
      this.cancelLong?.();
      this.cancelLong = this.timer(() => this.fireLongPress(), this.cfg.longPressMs);
      return;
    }
    this.clearLong();
    if (this.state === 'drag1') this.handlers.dragEnd?.(this.last, this.dragKind);
    if (n === 2) {
      this.state = 'pending2';
      this.multiStart = t;
      const [a, b] = [...this.pointers.values()];
      this.dist0 = this.prevDist = dist(a, b);
      this.center0 = this.prevCenter = mid(a, b);
    } else if (n >= 3) {
      if (this.state === 'scroll') this.handlers.scrollEnd?.();
      if (this.state === 'pinch') this.handlers.pinchEnd?.();
      this.state = 'pan3';
      this.prevCenter = centroid([...this.pointers.values()]);
    }
  }

  move(id: number, p: Pt, t: number): void {
    if (!this.pointers.has(id)) return;
    this.pointers.set(id, { ...p });
    switch (this.state) {
      case 'pending1':
      case 'longpressed': {
        if (dist(p, this.start) > this.cfg.slop) {
          this.dragKind = this.state === 'longpressed' ? 'long-drag' : this.afterTap ? 'tap-drag' : 'drag';
          this.clearLong();
          this.state = 'drag1';
          this.handlers.dragStart?.(this.start, this.dragKind);
          this.emitDrag(p, t);
        }
        break;
      }
      case 'drag1':
        this.emitDrag(p, t);
        break;
      case 'pending2': {
        const [a, b] = [...this.pointers.values()];
        const d = dist(a, b);
        const c = mid(a, b);
        if (Math.abs(d - this.dist0) > this.cfg.pinchThreshold) {
          this.state = 'pinch';
          this.multiMoved = true;
          this.prevDist = d;
          this.prevCenter = c;
        } else if (dist(c, this.center0) > this.cfg.scrollThreshold) {
          this.state = 'scroll';
          this.multiMoved = true;
          this.handlers.scroll?.(c.x - this.center0.x, c.y - this.center0.y, c);
          this.prevCenter = c;
        }
        break;
      }
      case 'scroll': {
        const [a, b] = [...this.pointers.values()];
        const c = mid(a, b);
        this.handlers.scroll?.(c.x - this.prevCenter.x, c.y - this.prevCenter.y, c);
        this.prevCenter = c;
        break;
      }
      case 'pinch': {
        const [a, b] = [...this.pointers.values()];
        const d = dist(a, b);
        const c = mid(a, b);
        const scale = this.prevDist > 0 ? d / this.prevDist : 1;
        this.handlers.pinch?.(scale, c, { x: c.x - this.prevCenter.x, y: c.y - this.prevCenter.y });
        this.prevDist = d;
        this.prevCenter = c;
        break;
      }
      case 'pan3': {
        const c = centroid([...this.pointers.values()]);
        this.multiMoved = true;
        this.handlers.pan?.({ x: c.x - this.prevCenter.x, y: c.y - this.prevCenter.y });
        this.prevCenter = c;
        break;
      }
      default:
        break;
    }
  }

  up(id: number, p: Pt, t: number): void {
    if (!this.pointers.has(id)) return;
    this.pointers.set(id, { ...p });
    const n = this.pointers.size;
    if (n === 1) {
      this.clearLong();
      if (this.state === 'pending1') {
        const count = this.afterTap && this.lastTap ? this.lastTap.count + 1 : 1;
        this.lastTap = { p: { ...p }, t, count };
        this.handlers.tap?.(this.start, count);
      } else if (this.state === 'drag1') {
        this.handlers.dragEnd?.(p, this.dragKind);
        this.lastTap = null;
      } else if (this.state === 'longpressed') {
        this.lastTap = null;
      }
      this.pointers.delete(id);
      this.state = 'idle';
      return;
    }
    // Saída de gesto com vários dedos.
    if (this.state === 'pending2' && this.maxPointers === 2 && !this.multiMoved && t - this.multiStart <= this.cfg.multiTapMs + 200) {
      this.handlers.twoFingerTap?.(mid(...([...this.pointers.values()] as [Pt, Pt])));
    }
    if (this.state === 'scroll') this.handlers.scrollEnd?.();
    if (this.state === 'pinch') this.handlers.pinchEnd?.();
    this.pointers.delete(id);
    this.lastTap = null;
    // Os dedos restantes não iniciam novos gestos até que todos sejam levantados.
    this.state = 'done';
    if (this.pointers.size === 0) this.state = 'idle';
  }

  cancel(id: number): void {
    if (!this.pointers.has(id)) return;
    this.clearLong();
    if (this.state === 'drag1') this.handlers.dragEnd?.(this.last, this.dragKind);
    if (this.state === 'scroll') this.handlers.scrollEnd?.();
    if (this.state === 'pinch') this.handlers.pinchEnd?.();
    this.pointers.delete(id);
    this.state = this.pointers.size === 0 ? 'idle' : 'done';
  }

  reset(): void {
    this.clearLong();
    this.pointers.clear();
    this.state = 'idle';
    this.lastTap = null;
  }

  private emitDrag(p: Pt, t: number): void {
    const delta = { x: p.x - this.last.x, y: p.y - this.last.y };
    const dt = t - this.lastTime;
    this.last = { ...p };
    this.lastTime = t;
    this.handlers.dragMove?.(p, delta, dt);
  }

  private fireLongPress(): void {
    this.cancelLong = null;
    if (this.state !== 'pending1') return;
    this.state = 'longpressed';
    this.handlers.longPress?.(this.start);
  }

  private clearLong(): void {
    this.cancelLong?.();
    this.cancelLong = null;
  }
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function mid(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function centroid(ps: Pt[]): Pt {
  const s = ps.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: s.x / ps.length, y: s.y / ps.length };
}
