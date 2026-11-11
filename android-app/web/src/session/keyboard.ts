/**
 * Teclado remoto.
 *
 * Usa o TECLADO NATIVO do Android (Gboard, Samsung etc.) por meio de um campo de texto oculto.
 * O texto é enviado ao PC em tempo real como Unicode (acentos, ç, símbolos e emojis funcionam
 * independentemente do layout do teclado do computador). Autocorreção e sugestões são tratadas
 * comparando o conteúdo do campo (diffText): enviamos apenas "N backspaces + texto novo".
 *
 * A barra de teclas especiais fica acima do teclado: ESC, TAB, CTRL, ALT, SHIFT, WIN, DEL,
 * ENTER, BACKSPACE, setas, Home/End/PgUp/PgDn, F1–F12 e atalhos. CTRL/ALT/SHIFT/WIN são
 * "fixáveis": um toque aplica à próxima tecla; dois toques travam até tocar de novo.
 */
import { h } from '@remotex/shared/dom';
import { diffText, sanitizeTypedText } from '@remotex/input/text-diff';
import { charToCode, keyDef } from '@remotex/input/keymap';
import type { RemoteConnection } from '../core/connection';
import { native } from '../core/native';

const SENTINEL = '​';

type Mod = 'ControlLeft' | 'AltLeft' | 'ShiftLeft' | 'MetaLeft';
const MOD_LABEL: Record<Mod, string> = { ControlLeft: 'Ctrl', AltLeft: 'Alt', ShiftLeft: 'Shift', MetaLeft: 'Win' };

/** Teclas de navegação físicas (teclado Bluetooth/USB) enviadas diretamente. */
const DIRECT_KEYS = new Set([
  'Escape', 'Tab', 'Enter', 'NumpadEnter', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PrintScreen', 'ContextMenu', 'Pause', 'ScrollLock', 'CapsLock', 'NumLock',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

export interface KeyboardHost {
  conn: RemoteConnection;
  canType: () => boolean;
  onVisibility: (open: boolean, barHeight: number) => void;
  onShortcuts: () => void;
}

export class RemoteKeyboard {
  readonly input: HTMLTextAreaElement;
  readonly bar: HTMLElement;
  private prev = SENTINEL;
  private composing = false;
  private mods = new Map<Mod, 'once' | 'lock'>();
  private modButtons = new Map<Mod, HTMLButtonElement>();
  private lastModTap = new Map<Mod, number>();
  open = false;
  private fnRow = false;
  private directBackspaceAt = 0;

  constructor(private readonly host: KeyboardHost) {
    this.input = h('textarea', {
      class: 'ime-input',
      autocapitalize: 'off',
      autocomplete: 'off',
      spellcheck: false,
      'aria-label': 'Digitação remota',
      'data-testid': 'ime',
    }) as HTMLTextAreaElement;
    this.input.setAttribute('autocorrect', 'off');
    this.input.value = SENTINEL;
    this.bar = h('div', { class: 'keybar', 'data-testid': 'keybar' });
    this.renderBar();
    this.wire();
  }

  private send(code: string, down: boolean): void {
    this.host.conn.sendControl({ k: 'key', code, down });
  }

  pressKey(code: string): void {
    if (!this.host.canType() || !keyDef(code)) return;
    const mods = this.activeMods();
    if (mods.length) this.host.conn.sendControl({ k: 'combo', codes: [...mods, code] });
    else {
      this.send(code, true);
      this.send(code, false);
    }
    this.consumeOnceMods();
  }

  combo(codes: string[]): void {
    if (!this.host.canType()) return;
    this.host.conn.sendControl({ k: 'combo', codes });
  }

  private activeMods(): Mod[] {
    return [...this.mods.keys()];
  }

  private consumeOnceMods(): void {
    let changed = false;
    for (const [m, st] of this.mods) {
      if (st === 'once') {
        this.mods.delete(m);
        changed = true;
      }
    }
    if (changed) this.updateModButtons();
  }

  private toggleMod(m: Mod): void {
    const now = performance.now();
    const last = this.lastModTap.get(m) ?? 0;
    this.lastModTap.set(m, now);
    const st = this.mods.get(m);
    if (!st) this.mods.set(m, now - last < 350 ? 'lock' : 'once');
    else if (st === 'once' && now - last < 350) this.mods.set(m, 'lock');
    else this.mods.delete(m);
    native.vibrate(8);
    this.updateModButtons();
  }

  private updateModButtons(): void {
    for (const [m, b] of this.modButtons) {
      const st = this.mods.get(m);
      b.classList.toggle('on', Boolean(st));
      b.classList.toggle('lock', st === 'lock');
      b.setAttribute('aria-pressed', String(Boolean(st)));
    }
  }

  private key(label: string, code: string, cls = ''): HTMLButtonElement {
    const b = h('button', { class: 'kb-key ' + cls, 'data-testid': `key-${code}`, 'aria-label': label }, label) as HTMLButtonElement;
    // pointerdown evita que o botão roube o foco do campo (o teclado nativo continua aberto)
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => this.pressKey(code));
    return b;
  }

  private renderBar(): void {
    const mods = (Object.keys(MOD_LABEL) as Mod[]).map((m) => {
      const b = h('button', { class: 'kb-key mod', 'data-testid': `mod-${m}`, 'aria-pressed': 'false' }, MOD_LABEL[m]) as HTMLButtonElement;
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.addEventListener('click', () => this.toggleMod(m));
      this.modButtons.set(m, b);
      return b;
    });
    const fnToggle = h('button', { class: 'kb-key', 'aria-label': 'Teclas de função' }, 'Fn') as HTMLButtonElement;
    fnToggle.addEventListener('pointerdown', (e) => e.preventDefault());
    fnToggle.addEventListener('click', () => {
      this.fnRow = !this.fnRow;
      fnRow.hidden = !this.fnRow;
      fnToggle.classList.toggle('on', this.fnRow);
      this.host.onVisibility(this.open, this.bar.offsetHeight);
    });
    const shortcuts = h('button', { class: 'kb-key accent', 'data-testid': 'open-shortcuts' }, 'Atalhos') as HTMLButtonElement;
    shortcuts.addEventListener('pointerdown', (e) => e.preventDefault());
    shortcuts.addEventListener('click', () => this.host.onShortcuts());
    const hide = h('button', { class: 'kb-key', 'aria-label': 'Fechar teclado' }, '⌄') as HTMLButtonElement;
    hide.addEventListener('click', () => this.hide());

    const main = h(
      'div',
      { class: 'kb-row' },
      this.key('Esc', 'Escape'),
      this.key('Tab', 'Tab'),
      ...mods,
      this.key('Del', 'Delete'),
      this.key('⌫', 'Backspace'),
      this.key('Enter', 'Enter', 'wide'),
      this.key('←', 'ArrowLeft'),
      this.key('↑', 'ArrowUp'),
      this.key('↓', 'ArrowDown'),
      this.key('→', 'ArrowRight'),
      this.key('Home', 'Home'),
      this.key('End', 'End'),
      this.key('PgUp', 'PageUp'),
      this.key('PgDn', 'PageDown'),
      this.key('Ins', 'Insert'),
      this.key('PrtSc', 'PrintScreen'),
      fnToggle,
      shortcuts,
      hide,
    );
    const fnRow = h('div', { class: 'kb-row fn' }, ...Array.from({ length: 12 }, (_, i) => this.key(`F${i + 1}`, `F${i + 1}`)));
    fnRow.hidden = true;
    this.bar.append(fnRow, main);
  }

  private wire(): void {
    const el = this.input;
    el.addEventListener('compositionstart', () => (this.composing = true));
    el.addEventListener('compositionend', () => {
      this.composing = false;
      this.sync();
      this.maybeReset();
    });
    el.addEventListener('input', () => {
      this.sync();
      if (!this.composing) this.maybeReset();
    });
    el.addEventListener('keydown', (e) => {
      // Teclados físicos e teclas especiais com código real (no Android, letras chegam como 229).
      if (e.keyCode === 229 || e.isComposing) return;
      const hasMod = e.ctrlKey || e.altKey || e.metaKey;
      if (hasMod && keyDef(e.code)) {
        e.preventDefault();
        const codes: string[] = [];
        if (e.ctrlKey) codes.push('ControlLeft');
        if (e.altKey) codes.push('AltLeft');
        if (e.shiftKey) codes.push('ShiftLeft');
        if (e.metaKey) codes.push('MetaLeft');
        this.combo([...codes, e.code]);
        return;
      }
      if (DIRECT_KEYS.has(e.code) || (e.key === 'Enter' && !e.code) || (e.key === 'Backspace' && !e.code)) {
        const code = e.code || (e.key === 'Enter' ? 'Enter' : 'Backspace');
        // Backspace com o campo "vazio" não gera evento de input: envia a tecla diretamente.
        if (code === 'Backspace' && el.value.length > SENTINEL.length && !this.activeMods().length) return;
        if (code === 'Backspace') this.directBackspaceAt = performance.now();
        e.preventDefault();
        this.pressKey(code);
      }
    });
    el.addEventListener('blur', () => {
      // o teclado nativo foi fechado pelo sistema (botão voltar)
      setTimeout(() => {
        if (document.activeElement !== el && this.open) this.setOpen(false);
      }, 150);
    });
  }

  private sync(): void {
    const next = this.input.value;
    if (next === this.prev) return;
    if (!this.host.canType()) {
      this.prev = next;
      return;
    }
    const prevBody = this.prev.startsWith(SENTINEL) ? this.prev.slice(SENTINEL.length) : this.prev;
    const lostSentinel = !next.startsWith(SENTINEL);
    const nextBody = lostSentinel ? next : next.slice(SENTINEL.length);
    const d = diffText(prevBody, nextBody);
    // Se a tecla Backspace já foi enviada diretamente, a perda do marcador não conta de novo.
    const alreadySent = lostSentinel && performance.now() - this.directBackspaceAt < 150;
    let backspaces = d.backspaces + (lostSentinel && !alreadySent ? 1 : 0);
    const insert = sanitizeTypedText(d.insert);
    this.prev = next;
    for (; backspaces > 0; backspaces--) {
      this.send('Backspace', true);
      this.send('Backspace', false);
    }
    if (!insert) {
      if (lostSentinel) this.reset();
      return;
    }
    const mods = this.activeMods();
    if (mods.length) {
      // Com Ctrl/Alt/Win ativos, cada caractere vira um atalho (ex.: Ctrl + c).
      for (const ch of Array.from(insert)) {
        const code = charToCode(ch);
        if (code) this.host.conn.sendControl({ k: 'combo', codes: [...mods, code] });
        else this.host.conn.sendControl({ k: 'text', text: ch });
      }
      this.consumeOnceMods();
      this.reset();
      return;
    }
    this.host.conn.sendControl({ k: 'text', text: insert });
    if (lostSentinel || insert.includes('\n')) this.reset();
  }

  private maybeReset(): void {
    if (this.input.value.length > 48 || !this.input.value.startsWith(SENTINEL)) this.reset();
  }

  private reset(): void {
    this.input.value = SENTINEL;
    this.prev = SENTINEL;
    try {
      this.input.setSelectionRange(SENTINEL.length, SENTINEL.length);
    } catch {
      /* ignora */
    }
  }

  show(): void {
    this.reset();
    this.input.focus({ preventScroll: true });
    native.showKeyboard();
    this.setOpen(true);
  }

  hide(): void {
    this.input.blur();
    native.hideKeyboard();
    this.setOpen(false);
  }

  toggle(): void {
    this.open ? this.hide() : this.show();
  }

  private setOpen(v: boolean): void {
    this.open = v;
    this.bar.classList.toggle('visible', v);
    requestAnimationFrame(() => this.host.onVisibility(v, v ? this.bar.offsetHeight : 0));
  }
}

/** Atalhos prontos (folha "Atalhos"). */
export const SHORTCUTS: Array<{ label: string; codes?: string[]; special?: 'ctrl-alt-del' | 'lock' | 'task-manager'; hint?: string }> = [
  { label: 'Copiar', codes: ['ControlLeft', 'KeyC'], hint: 'Ctrl+C' },
  { label: 'Colar', codes: ['ControlLeft', 'KeyV'], hint: 'Ctrl+V' },
  { label: 'Recortar', codes: ['ControlLeft', 'KeyX'], hint: 'Ctrl+X' },
  { label: 'Desfazer', codes: ['ControlLeft', 'KeyZ'], hint: 'Ctrl+Z' },
  { label: 'Refazer', codes: ['ControlLeft', 'KeyY'], hint: 'Ctrl+Y' },
  { label: 'Selecionar tudo', codes: ['ControlLeft', 'KeyA'], hint: 'Ctrl+A' },
  { label: 'Salvar', codes: ['ControlLeft', 'KeyS'], hint: 'Ctrl+S' },
  { label: 'Localizar', codes: ['ControlLeft', 'KeyF'], hint: 'Ctrl+F' },
  { label: 'Alternar janelas', codes: ['AltLeft', 'Tab'], hint: 'Alt+Tab' },
  { label: 'Fechar janela', codes: ['AltLeft', 'F4'], hint: 'Alt+F4' },
  { label: 'Menu Iniciar', codes: ['MetaLeft'], hint: 'Win' },
  { label: 'Área de trabalho', codes: ['MetaLeft', 'KeyD'], hint: 'Win+D' },
  { label: 'Explorador de arquivos', codes: ['MetaLeft', 'KeyE'], hint: 'Win+E' },
  { label: 'Executar', codes: ['MetaLeft', 'KeyR'], hint: 'Win+R' },
  { label: 'Maximizar', codes: ['MetaLeft', 'ArrowUp'], hint: 'Win+↑' },
  { label: 'Minimizar', codes: ['MetaLeft', 'ArrowDown'], hint: 'Win+↓' },
  { label: 'Janela à esquerda', codes: ['MetaLeft', 'ArrowLeft'], hint: 'Win+←' },
  { label: 'Janela à direita', codes: ['MetaLeft', 'ArrowRight'], hint: 'Win+→' },
  { label: 'Visão de tarefas', codes: ['MetaLeft', 'Tab'], hint: 'Win+Tab' },
  { label: 'Nova aba', codes: ['ControlLeft', 'KeyT'], hint: 'Ctrl+T' },
  { label: 'Fechar aba', codes: ['ControlLeft', 'KeyW'], hint: 'Ctrl+W' },
  { label: 'Atualizar', codes: ['F5'], hint: 'F5' },
  { label: 'Captura de tela', codes: ['MetaLeft', 'ShiftLeft', 'KeyS'], hint: 'Win+Shift+S' },
  { label: 'Gerenciador de Tarefas', special: 'task-manager', hint: 'Ctrl+Shift+Esc' },
  { label: 'Ctrl+Alt+Del', special: 'ctrl-alt-del', hint: 'Sequência de segurança' },
  { label: 'Bloquear computador', special: 'lock', hint: 'Win+L' },
];
