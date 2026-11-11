/**
 * Interface de injeção de entrada no sistema operacional do computador controlado.
 * Implementações: windows-injector.ts (SendInput/user32) e linux-injector.ts (XTest).
 * Todas as coordenadas estão em pixels físicos do desktop virtual.
 */
import type { MouseButton } from '@remotex/media/channel-protocol';

export interface InjectResult {
  ok: boolean;
  /** true quando o SO recusou a entrada (ex.: janela elevada/UAC — UIPI no Windows). */
  blocked?: boolean;
}

export interface InputInjector {
  readonly name: string;
  moveTo(x: number, y: number): InjectResult;
  button(b: MouseButton, down: boolean): InjectResult;
  /** Unidades de roda: 120 = 1 "clique" de roda. Valores positivos de dy rolam para baixo. */
  wheel(dx: number, dy: number): InjectResult;
  key(code: string, down: boolean): InjectResult;
  typeText(text: string): InjectResult;
  /** Posição atual do cursor em pixels do desktop virtual, se disponível. */
  cursorPosition(): { x: number; y: number } | null;
  /** true se o foco atual parece ser um campo de texto (cursor de texto/caret ativo). */
  caretActive(): boolean | null;
  dispose(): void;
}

/** Injetor que apenas registra as chamadas — usado em testes e como fallback seguro. */
export class RecordingInjector implements InputInjector {
  readonly name = 'recording';
  calls: Array<[string, ...unknown[]]> = [];
  cursor = { x: 0, y: 0 };
  blockAll = false;

  private r(ok = true): InjectResult {
    return this.blockAll ? { ok: false, blocked: true } : { ok };
  }
  moveTo(x: number, y: number) {
    this.calls.push(['move', x, y]);
    this.cursor = { x, y };
    return this.r();
  }
  button(b: MouseButton, down: boolean) {
    this.calls.push(['button', b, down]);
    return this.r();
  }
  wheel(dx: number, dy: number) {
    this.calls.push(['wheel', dx, dy]);
    return this.r();
  }
  key(code: string, down: boolean) {
    this.calls.push(['key', code, down]);
    return this.r();
  }
  typeText(text: string) {
    this.calls.push(['text', text]);
    return this.r();
  }
  cursorPosition() {
    return this.cursor;
  }
  caretActive() {
    return null;
  }
  dispose() {}
}
