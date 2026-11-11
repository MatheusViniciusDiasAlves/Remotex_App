/**
 * Despachante de entrada do HOST: recebe eventos do canal de dados, valida permissões e
 * limites, converte coordenadas normalizadas em pixels e chama o injetor do sistema.
 * Mantém o estado de teclas/botões pressionados para liberá-los ao fim da sessão
 * (evita teclas "presas" se a conexão cair no meio de um atalho).
 */
import type { InputEvent, MouseButton } from '@remotex/media/channel-protocol';
import { MAX_TEXT_INPUT } from '@remotex/media/channel-protocol';
import type { PermissionSet } from '@remotex/security/permissions';
import type { InputInjector, InjectResult } from './injector';
import { keyDef } from './keymap';
import { normalizedToDesktop, type Rect } from '@remotex/capture/geometry';

export interface DispatchOutcome {
  ok: boolean;
  reason?: 'forbidden' | 'invalid' | 'stale' | 'blocked' | 'unknown-key';
}

export interface DispatcherOptions {
  injector: InputInjector;
  getDisplayRect: () => Rect;
  getPermissions: () => PermissionSet;
  onBlocked?: () => void;
}

const MAX_WHEEL = 120 * 30;
const MAX_COMBO = 6;

export class InputDispatcher {
  private keys = new Set<string>();
  private buttons = new Set<MouseButton>();
  private lastButtonSeq = -1;
  private lastMotionSeq = -1;

  constructor(private readonly opts: DispatcherOptions) {}

  get pressedKeys(): string[] {
    return [...this.keys];
  }

  get pressedButtons(): MouseButton[] {
    return [...this.buttons];
  }

  handle(ev: InputEvent): DispatchOutcome {
    const perms = this.opts.getPermissions();
    switch (ev.k) {
      case 'mv': {
        if (!perms.control) return { ok: false, reason: 'forbidden' };
        if (!this.validXY(ev.x, ev.y) || !Number.isInteger(ev.s)) return { ok: false, reason: 'invalid' };
        if (ev.s <= this.lastMotionSeq || ev.s <= this.lastButtonSeq) return { ok: false, reason: 'stale' };
        this.lastMotionSeq = ev.s;
        return this.track(this.moveNormalized(ev.x, ev.y));
      }
      case 'btn': {
        if (!perms.control) return { ok: false, reason: 'forbidden' };
        if (!this.validButton(ev.b) || !this.validXY(ev.x, ev.y)) return { ok: false, reason: 'invalid' };
        if (Number.isInteger(ev.s)) this.lastButtonSeq = Math.max(this.lastButtonSeq, ev.s);
        this.moveNormalized(ev.x, ev.y);
        const r = this.opts.injector.button(ev.b, ev.down);
        if (ev.down) this.buttons.add(ev.b);
        else this.buttons.delete(ev.b);
        return this.track(r);
      }
      case 'click': {
        if (!perms.control) return { ok: false, reason: 'forbidden' };
        if (!this.validButton(ev.b) || !this.validXY(ev.x, ev.y) || (ev.n !== 1 && ev.n !== 2)) return { ok: false, reason: 'invalid' };
        if (Number.isInteger(ev.s)) this.lastButtonSeq = Math.max(this.lastButtonSeq, ev.s);
        let r = this.moveNormalized(ev.x, ev.y);
        for (let i = 0; i < ev.n; i++) {
          r = this.merge(r, this.opts.injector.button(ev.b, true));
          r = this.merge(r, this.opts.injector.button(ev.b, false));
        }
        return this.track(r);
      }
      case 'wheel': {
        if (!perms.control) return { ok: false, reason: 'forbidden' };
        if (!Number.isFinite(ev.dx) || !Number.isFinite(ev.dy)) return { ok: false, reason: 'invalid' };
        if (this.validXY(ev.x, ev.y) && this.buttons.size === 0) this.moveNormalized(ev.x, ev.y);
        const dx = Math.round(Math.max(-MAX_WHEEL, Math.min(MAX_WHEEL, ev.dx)));
        const dy = Math.round(Math.max(-MAX_WHEEL, Math.min(MAX_WHEEL, ev.dy)));
        if (dx === 0 && dy === 0) return { ok: true };
        return this.track(this.opts.injector.wheel(dx, dy));
      }
      case 'key': {
        if (!perms.keyboard) return { ok: false, reason: 'forbidden' };
        if (typeof ev.code !== 'string' || !keyDef(ev.code)) return { ok: false, reason: 'unknown-key' };
        const r = this.opts.injector.key(ev.code, Boolean(ev.down));
        if (ev.down) this.keys.add(ev.code);
        else this.keys.delete(ev.code);
        return this.track(r);
      }
      case 'combo': {
        if (!perms.keyboard) return { ok: false, reason: 'forbidden' };
        if (!Array.isArray(ev.codes) || ev.codes.length === 0 || ev.codes.length > MAX_COMBO) return { ok: false, reason: 'invalid' };
        if (!ev.codes.every((c) => typeof c === 'string' && keyDef(c))) return { ok: false, reason: 'unknown-key' };
        let r: InjectResult = { ok: true };
        for (const c of ev.codes) r = this.merge(r, this.opts.injector.key(c, true));
        for (const c of [...ev.codes].reverse()) r = this.merge(r, this.opts.injector.key(c, false));
        return this.track(r);
      }
      case 'text': {
        if (!perms.keyboard) return { ok: false, reason: 'forbidden' };
        if (typeof ev.text !== 'string' || ev.text.length === 0 || ev.text.length > MAX_TEXT_INPUT) return { ok: false, reason: 'invalid' };
        const text = ev.text.replace(/\r\n?/g, '\n');
        return this.track(this.opts.injector.typeText(text));
      }
      case 'release':
        this.releaseAll();
        return { ok: true };
      default:
        return { ok: false, reason: 'invalid' };
    }
  }

  /** Solta todas as teclas e botões pressionados (fim de sessão, perda de conexão). */
  releaseAll(): void {
    for (const code of [...this.keys].reverse()) this.opts.injector.key(code, false);
    for (const b of this.buttons) this.opts.injector.button(b, false);
    this.keys.clear();
    this.buttons.clear();
  }

  private moveNormalized(nx: number, ny: number): InjectResult {
    const p = normalizedToDesktop(nx, ny, this.opts.getDisplayRect());
    return this.opts.injector.moveTo(p.x, p.y);
  }

  private validXY(x: unknown, y: unknown): boolean {
    return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) && x >= -0.01 && x <= 1.01 && y >= -0.01 && y <= 1.01;
  }

  private validButton(b: unknown): b is MouseButton {
    return b === 0 || b === 1 || b === 2;
  }

  private merge(a: InjectResult, b: InjectResult): InjectResult {
    return { ok: a.ok && b.ok, blocked: Boolean(a.blocked || b.blocked) };
  }

  private track(r: InjectResult): DispatchOutcome {
    if (r.blocked) {
      this.opts.onBlocked?.();
      return { ok: false, reason: 'blocked' };
    }
    return { ok: r.ok };
  }
}
