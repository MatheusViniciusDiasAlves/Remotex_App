/**
 * Tabela de teclas: códigos físicos padronizados (KeyboardEvent.code) → teclas virtuais do
 * Windows (VK_*) e keysyms X11. O celular envia sempre "code"; texto livre (acentos, ç, emojis)
 * é enviado como Unicode e não depende do layout de teclado do computador.
 */
export interface KeyDef {
  vk: number; // Windows virtual-key
  ext?: boolean; // tecla estendida (prefixo E0)
  x11: number; // keysym X11
  label?: string;
}

const K: Record<string, KeyDef> = {
  Backspace: { vk: 0x08, x11: 0xff08, label: '⌫' },
  Tab: { vk: 0x09, x11: 0xff09, label: 'Tab' },
  Enter: { vk: 0x0d, x11: 0xff0d, label: 'Enter' },
  NumpadEnter: { vk: 0x0d, ext: true, x11: 0xff8d },
  ShiftLeft: { vk: 0xa0, x11: 0xffe1, label: 'Shift' },
  ShiftRight: { vk: 0xa1, x11: 0xffe2 },
  ControlLeft: { vk: 0xa2, x11: 0xffe3, label: 'Ctrl' },
  ControlRight: { vk: 0xa3, ext: true, x11: 0xffe4 },
  AltLeft: { vk: 0xa4, x11: 0xffe9, label: 'Alt' },
  AltRight: { vk: 0xa5, ext: true, x11: 0xffea, label: 'AltGr' },
  MetaLeft: { vk: 0x5b, ext: true, x11: 0xffeb, label: 'Win' },
  MetaRight: { vk: 0x5c, ext: true, x11: 0xffec },
  ContextMenu: { vk: 0x5d, ext: true, x11: 0xff67, label: 'Menu' },
  Pause: { vk: 0x13, x11: 0xff13, label: 'Pause' },
  CapsLock: { vk: 0x14, x11: 0xffe5, label: 'Caps' },
  Escape: { vk: 0x1b, x11: 0xff1b, label: 'Esc' },
  Space: { vk: 0x20, x11: 0x20, label: 'Espaço' },
  PageUp: { vk: 0x21, ext: true, x11: 0xff55, label: 'PgUp' },
  PageDown: { vk: 0x22, ext: true, x11: 0xff56, label: 'PgDn' },
  End: { vk: 0x23, ext: true, x11: 0xff57, label: 'End' },
  Home: { vk: 0x24, ext: true, x11: 0xff50, label: 'Home' },
  ArrowLeft: { vk: 0x25, ext: true, x11: 0xff51, label: '←' },
  ArrowUp: { vk: 0x26, ext: true, x11: 0xff52, label: '↑' },
  ArrowRight: { vk: 0x27, ext: true, x11: 0xff53, label: '→' },
  ArrowDown: { vk: 0x28, ext: true, x11: 0xff54, label: '↓' },
  PrintScreen: { vk: 0x2c, ext: true, x11: 0xff61, label: 'PrtSc' },
  Insert: { vk: 0x2d, ext: true, x11: 0xff63, label: 'Ins' },
  Delete: { vk: 0x2e, ext: true, x11: 0xffff, label: 'Del' },
  NumLock: { vk: 0x90, ext: true, x11: 0xff7f },
  ScrollLock: { vk: 0x91, x11: 0xff14 },
  NumpadMultiply: { vk: 0x6a, x11: 0xffaa },
  NumpadAdd: { vk: 0x6b, x11: 0xffab },
  NumpadSubtract: { vk: 0x6d, x11: 0xffad },
  NumpadDecimal: { vk: 0x6e, x11: 0xffae },
  NumpadDivide: { vk: 0x6f, ext: true, x11: 0xffaf },
  NumpadComma: { vk: 0xc2, x11: 0xffac },
  Semicolon: { vk: 0xba, x11: 0x3b },
  Equal: { vk: 0xbb, x11: 0x3d },
  Comma: { vk: 0xbc, x11: 0x2c },
  Minus: { vk: 0xbd, x11: 0x2d },
  Period: { vk: 0xbe, x11: 0x2e },
  Slash: { vk: 0xbf, x11: 0x2f },
  Backquote: { vk: 0xc0, x11: 0x60 },
  BracketLeft: { vk: 0xdb, x11: 0x5b },
  Backslash: { vk: 0xdc, x11: 0x5c },
  BracketRight: { vk: 0xdd, x11: 0x5d },
  Quote: { vk: 0xde, x11: 0x27 },
  IntlBackslash: { vk: 0xe2, x11: 0x3c },
  IntlRo: { vk: 0xc1, x11: 0x2f },
  AudioVolumeMute: { vk: 0xad, ext: true, x11: 0x1008ff12, label: 'Mudo' },
  AudioVolumeDown: { vk: 0xae, ext: true, x11: 0x1008ff11, label: 'Vol−' },
  AudioVolumeUp: { vk: 0xaf, ext: true, x11: 0x1008ff13, label: 'Vol+' },
  MediaTrackNext: { vk: 0xb0, ext: true, x11: 0x1008ff17, label: '⏭' },
  MediaTrackPrevious: { vk: 0xb1, ext: true, x11: 0x1008ff16, label: '⏮' },
  MediaStop: { vk: 0xb2, ext: true, x11: 0x1008ff15, label: '⏹' },
  MediaPlayPause: { vk: 0xb3, ext: true, x11: 0x1008ff14, label: '⏯' },
  BrowserBack: { vk: 0xa6, ext: true, x11: 0x1008ff26 },
  BrowserForward: { vk: 0xa7, ext: true, x11: 0x1008ff27 },
  BrowserRefresh: { vk: 0xa8, ext: true, x11: 0x1008ff29 },
  BrowserHome: { vk: 0xac, ext: true, x11: 0x1008ff18 },
};

for (let i = 0; i < 26; i++) {
  const ch = String.fromCharCode(65 + i);
  K[`Key${ch}`] = { vk: 0x41 + i, x11: 0x61 + i, label: ch };
}
for (let i = 0; i <= 9; i++) {
  K[`Digit${i}`] = { vk: 0x30 + i, x11: 0x30 + i, label: String(i) };
  K[`Numpad${i}`] = { vk: 0x60 + i, x11: 0xffb0 + i };
}
for (let i = 1; i <= 24; i++) {
  K[`F${i}`] = { vk: 0x6f + i, x11: 0xffbd + i, label: `F${i}` };
}

export const KEYMAP: Readonly<Record<string, KeyDef>> = K;

export function keyDef(code: string): KeyDef | undefined {
  return Object.prototype.hasOwnProperty.call(K, code) ? K[code] : undefined;
}

export const MODIFIER_CODES = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
]);

export function isModifier(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

/**
 * Converte um caractere digitado no código físico equivalente (layout US), usado quando o
 * usuário combina Ctrl/Alt/Win da barra especial com uma tecla do teclado do celular
 * (ex.: Ctrl + "c" → combo ControlLeft+KeyC).
 */
export function charToCode(ch: string): string | undefined {
  if (!ch || ch.length !== 1) return undefined;
  const c = ch.toLowerCase();
  if (c >= 'a' && c <= 'z') return `Key${c.toUpperCase()}`;
  if (c >= '0' && c <= '9') return `Digit${c}`;
  const map: Record<string, string> = {
    ' ': 'Space',
    '\n': 'Enter',
    '\t': 'Tab',
    '-': 'Minus',
    '=': 'Equal',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '\\': 'Backslash',
    ';': 'Semicolon',
    "'": 'Quote',
    '`': 'Backquote',
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash',
  };
  return map[c];
}
