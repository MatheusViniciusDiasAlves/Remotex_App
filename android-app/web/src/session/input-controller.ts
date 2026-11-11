/**
 * Converte toques na tela do celular em ações no computador.
 *
 * MODO TOUCH (toque direto):
 *   toque = clique esquerdo no ponto • duplo toque = duplo clique • toque prolongado = clique
 *   direito • arrastar 1 dedo = arrastar e soltar/selecionar • 2 dedos tocando = clique direito •
 *   2 dedos deslizando = rolagem • pinça = zoom • 3 dedos = mover a imagem ampliada
 *
 * MODO MOUSE (touchpad virtual):
 *   deslizar 1 dedo = mover o cursor (com aceleração) • toque = clique no cursor • toque prolongado
 *   e soltar = clique direito • tocar e arrastar / prolongado e arrastar = arrastar com botão
 *   pressionado • 2 dedos tocando = clique direito • 2 dedos deslizando = rolagem • pinça = zoom
 */
import { GestureRecognizer, type DragKind, type Pt } from '@remotex/input/gestures';
import { touchpadDelta, scrollToWheel } from '@remotex/input/touchpad';
import type { MouseButton } from '@remotex/media/channel-protocol';
import type { Viewport } from '../core/viewport';
import type { RemoteConnection } from '../core/connection';
import type { ControlMode } from '../core/storage';
import { native } from '../core/native';

export interface InputHost {
  conn: RemoteConnection;
  viewport: Viewport;
  stage: HTMLElement;
  mode: () => ControlMode;
  canControl: () => boolean;
  settings: () => { haptics: boolean; invertScroll: boolean; sensitivity: number };
  remoteSize: () => { width: number; height: number };
  onViewportChange: () => void;
  onCursor: (x: number, y: number, active: boolean) => void;
  onTap: (p: Pt) => void;
  onInteraction: () => void;
}

export class InputController {
  readonly recognizer: GestureRecognizer;
  cursor = { x: 0.5, y: 0.5 };
  private dragging: { button: MouseButton | null; kind: DragKind } | null = null;
  private wheelAcc = { x: 0, y: 0 };
  private lastLocalMove = 0;
  private edgeTimer: number | null = null;
  private lastPoint: Pt = { x: 0, y: 0 };

  constructor(private readonly host: InputHost) {
    this.recognizer = new GestureRecognizer({
      touchStart: () => host.onInteraction(),
      tap: (p, count) => this.onTap(p, count),
      twoFingerTap: (p) => this.click(2, this.mode === 'touch' ? this.at(p) : this.cursor),
      longPress: (p) => this.onLongPress(p),
      longPressUp: () => this.onLongPressUp(),
      dragStart: (p, kind) => this.onDragStart(p, kind),
      dragMove: (p, d, dt) => this.onDragMove(p, d, dt),
      dragEnd: (p) => this.onDragEnd(p),
      scroll: (dx, dy, c) => this.onScroll(dx, dy, c),
      scrollEnd: () => (this.wheelAcc = { x: 0, y: 0 }),
      pinch: (scale, c, pan) => {
        host.viewport.zoomAt(scale, c.x, c.y);
        host.viewport.panBy(pan.x, pan.y);
        host.onViewportChange();
      },
      pan: (d) => {
        host.viewport.panBy(d.x, d.y);
        host.onViewportChange();
      },
    });
    this.bind();
  }

  private get mode(): ControlMode {
    return this.host.mode();
  }

  private local(e: PointerEvent): Pt {
    const r = this.host.stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private bind(): void {
    const el = this.host.stage;
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return this.mouseDown(e);
      el.setPointerCapture?.(e.pointerId);
      this.recognizer.down(e.pointerId, this.local(e), e.timeStamp);
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') return this.mouseMove(e);
      this.recognizer.move(e.pointerId, this.local(e), e.timeStamp);
    });
    el.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'mouse') return this.mouseUp(e);
      this.recognizer.up(e.pointerId, this.local(e), e.timeStamp);
    });
    el.addEventListener('pointercancel', (e) => this.recognizer.cancel(e.pointerId));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // Mouse/trackpad físico (tablet com mouse, Chromebook, navegador de desktop): repasse direto.
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (e.ctrlKey) {
          const p = this.local(e as unknown as PointerEvent);
          this.host.viewport.zoomAt(Math.exp(-e.deltaY / 300), p.x, p.y);
          return this.host.onViewportChange();
        }
        const p = this.at(this.local(e as unknown as PointerEvent));
        const unit = e.deltaMode === 1 ? 40 : 1;
        this.host.conn.sendControl({ k: 'wheel', dx: Math.round(e.deltaX * unit * 1.2), dy: Math.round(e.deltaY * unit * 1.2), x: p.x, y: p.y });
      },
      { passive: false },
    );
  }

  // ---- mouse físico ---------------------------------------------------------------------------
  private mouseDown(e: PointerEvent): void {
    if (!this.host.canControl()) return;
    const p = this.at(this.local(e));
    const b = (e.button === 1 ? 1 : e.button === 2 ? 2 : 0) as MouseButton;
    this.host.conn.sendControl({ k: 'btn', b, down: true, x: p.x, y: p.y, s: this.host.conn.nextSeq() });
    this.host.stage.setPointerCapture?.(e.pointerId);
    this.host.onTap(this.local(e));
  }
  private mouseMove(e: PointerEvent): void {
    if (!this.host.canControl()) return;
    const p = this.at(this.local(e));
    this.host.conn.sendMotion({ k: 'mv', x: p.x, y: p.y, s: this.host.conn.nextSeq() });
  }
  private mouseUp(e: PointerEvent): void {
    if (!this.host.canControl()) return;
    const p = this.at(this.local(e));
    const b = (e.button === 1 ? 1 : e.button === 2 ? 2 : 0) as MouseButton;
    this.host.conn.sendControl({ k: 'btn', b, down: false, x: p.x, y: p.y, s: this.host.conn.nextSeq() });
  }

  // ---- utilidades -----------------------------------------------------------------------------
  private at(p: Pt): { x: number; y: number } {
    const r = this.host.viewport.toRemote(p.x, p.y);
    return { x: round(r.x), y: round(r.y) };
  }

  private haptic(ms = 12): void {
    if (this.host.settings().haptics) native.vibrate(ms);
  }

  click(b: MouseButton, pos: { x: number; y: number }, n: 1 | 2 = 1): void {
    if (!this.host.canControl()) return;
    this.host.conn.sendControl({ k: 'click', b, x: pos.x, y: pos.y, n, s: this.host.conn.nextSeq() });
    if (b === 2) this.haptic(25);
  }

  /** Pressiona/solta um botão na posição atual do cursor (botões L/M/R do modo mouse). */
  button(b: MouseButton, down: boolean): void {
    if (!this.host.canControl()) return;
    this.host.conn.sendControl({ k: 'btn', b, down, x: this.cursor.x, y: this.cursor.y, s: this.host.conn.nextSeq() });
    if (down) this.haptic(10);
  }

  setCursorFromHost(x: number, y: number): void {
    if (this.dragging || performance.now() - this.lastLocalMove < 400) return;
    this.cursor = { x, y };
    this.host.onCursor(x, y, false);
  }

  // ---- gestos ---------------------------------------------------------------------------------
  private onTap(p: Pt, count: number): void {
    this.host.onTap(p);
    if (this.mode === 'touch') {
      const pos = this.at(p);
      this.cursor = pos;
      this.click(0, pos, 1);
      this.host.onCursor(pos.x, pos.y, false);
    } else {
      this.click(0, this.cursor, 1);
    }
    if (count === 1) this.haptic(6);
  }

  private onLongPress(p: Pt): void {
    if (this.mode === 'touch') {
      const pos = this.at(p);
      this.cursor = pos;
      this.click(2, pos);
    } else {
      this.haptic(30); // pronto para arrastar ou clique direito ao soltar
    }
  }

  private onLongPressUp(): void {
    if (this.mode === 'mouse') this.click(2, this.cursor);
  }

  private onDragStart(p: Pt, kind: DragKind): void {
    this.lastPoint = p;
    if (!this.host.canControl()) {
      this.dragging = { button: null, kind };
      return;
    }
    if (this.mode === 'touch') {
      if (kind === 'long-drag') {
        // já houve clique direito no toque prolongado; arrastar apenas move a imagem
        this.dragging = { button: null, kind };
        return;
      }
      const pos = this.at(p);
      this.cursor = pos;
      this.host.conn.sendControl({ k: 'btn', b: 0, down: true, x: pos.x, y: pos.y, s: this.host.conn.nextSeq() });
      this.dragging = { button: 0, kind };
    } else {
      const withButton = kind === 'tap-drag' || kind === 'long-drag';
      if (withButton) {
        this.host.conn.sendControl({ k: 'btn', b: 0, down: true, x: this.cursor.x, y: this.cursor.y, s: this.host.conn.nextSeq() });
        this.haptic(15);
      }
      this.dragging = { button: withButton ? 0 : null, kind };
    }
  }

  private onDragMove(p: Pt, d: Pt, dt: number): void {
    this.lastPoint = p;
    this.lastLocalMove = performance.now();
    const v = this.host.viewport;
    if (this.mode === 'touch') {
      if (!this.dragging || this.dragging.button === null) {
        v.panBy(d.x, d.y);
        return this.host.onViewportChange();
      }
      const pos = this.at(p);
      this.cursor = pos;
      this.host.conn.sendMotion({ k: 'mv', x: pos.x, y: pos.y, s: this.host.conn.nextSeq() });
      this.host.onCursor(pos.x, pos.y, true);
      this.edgePan(p);
      return;
    }
    // modo mouse: deslocamento relativo com aceleração
    const remote = this.host.remoteSize();
    const delta = touchpadDelta(d.x, d.y, dt, remote, { sensitivity: this.host.settings().sensitivity, acceleration: 1 });
    this.cursor = { x: clamp01(this.cursor.x + delta.dx), y: clamp01(this.cursor.y + delta.dy) };
    this.cursor = { x: round(this.cursor.x), y: round(this.cursor.y) };
    if (this.host.canControl()) this.host.conn.sendMotion({ k: 'mv', x: this.cursor.x, y: this.cursor.y, s: this.host.conn.nextSeq() });
    this.host.onCursor(this.cursor.x, this.cursor.y, true);
    if (v.isZoomed && v.ensureVisible(this.cursor.x, this.cursor.y, 60)) this.host.onViewportChange();
  }

  private onDragEnd(p: Pt): void {
    this.stopEdgePan();
    const d = this.dragging;
    this.dragging = null;
    if (!d || d.button === null) return;
    const pos = this.mode === 'touch' ? this.at(p) : this.cursor;
    this.host.conn.sendControl({ k: 'btn', b: d.button, down: false, x: pos.x, y: pos.y, s: this.host.conn.nextSeq() });
  }

  private onScroll(dx: number, dy: number, c: Pt): void {
    if (!this.host.canControl()) return;
    const inv = this.host.settings().invertScroll ? -1 : 1;
    // rolagem "natural": dedos para cima rolam o conteúdo para baixo
    this.wheelAcc.x += -scrollToWheel(dx) * inv;
    this.wheelAcc.y += -scrollToWheel(dy) * inv;
    const sx = Math.trunc(this.wheelAcc.x);
    const sy = Math.trunc(this.wheelAcc.y);
    if (Math.abs(sx) < 8 && Math.abs(sy) < 8) return;
    this.wheelAcc.x -= sx;
    this.wheelAcc.y -= sy;
    const pos = this.mode === 'touch' ? this.at(c) : this.cursor;
    this.host.conn.sendControl({ k: 'wheel', dx: sx, dy: sy, x: pos.x, y: pos.y });
  }

  /** Ao arrastar perto da borda com a imagem ampliada, a imagem acompanha o dedo. */
  private edgePan(p: Pt): void {
    const v = this.host.viewport;
    if (!v.isZoomed) return this.stopEdgePan();
    const m = 36;
    const vx = p.x < m ? 1 : p.x > v.cw - m ? -1 : 0;
    const vy = p.y < m ? 1 : p.y > v.ch - m ? -1 : 0;
    if (!vx && !vy) return this.stopEdgePan();
    if (this.edgeTimer) return;
    this.edgeTimer = window.setInterval(() => {
      v.panBy(vx * 12, vy * 12);
      this.host.onViewportChange();
      if (this.dragging?.button !== null && this.dragging) {
        const pos = this.at(this.lastPoint);
        this.host.conn.sendMotion({ k: 'mv', x: pos.x, y: pos.y, s: this.host.conn.nextSeq() });
      }
    }, 30);
  }

  private stopEdgePan(): void {
    if (this.edgeTimer) clearInterval(this.edgeTimer);
    this.edgeTimer = null;
  }

  dispose(): void {
    this.stopEdgePan();
    this.recognizer.reset();
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function round(v: number): number {
  return Math.round(v * 100000) / 100000;
}
