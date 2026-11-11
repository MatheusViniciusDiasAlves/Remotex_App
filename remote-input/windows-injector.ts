/**
 * Injeção de entrada no Windows via APIs oficiais da user32.dll (SendInput), chamadas por FFI
 * (koffi). Não usa drivers, hooks globais nem técnicas de contorno de segurança.
 *
 * Limitações impostas pelo Windows (documentadas em documentation/LIMITACOES):
 *  - UIPI: um processo sem elevação não consegue enviar entrada para janelas de processos
 *    elevados (ex.: Gerenciador de Tarefas, instaladores, prompt do UAC). O RemoteX detecta
 *    quando a janela em primeiro plano é elevada e avisa o celular; a solução é reiniciar o host
 *    como administrador pelo consentimento oficial do UAC (ver elevation.ts no host).
 *  - Ctrl+Alt+Del (SAS) não pode ser gerado por SendInput — exige serviço do sistema.
 */
import * as koffi from 'koffi';
import type { MouseButton } from '@remotex/media/channel-protocol';
import type { InjectResult, InputInjector } from './injector';
import { keyDef } from './keymap';
import { toWindowsAbsolute, type Rect } from '@remotex/capture/geometry';

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;

const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_HWHEEL = 0x01000;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;
const MOUSEEVENTF_ABSOLUTE = 0x8000;

const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;

const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

const VK_RETURN = 0x0d;
const VK_TAB = 0x09;

/** Marcador em dwExtraInfo para identificar eventos injetados pelo RemoteX. */
export const REMOTEX_EXTRA_INFO = 0x52454d58; // "REMX"

// ---- Tipos C (tamanhos explícitos: idênticos no ABI x64 do Windows e do Linux) ----
export const MOUSEINPUT = koffi.struct('RX_MOUSEINPUT', {
  dx: 'int32',
  dy: 'int32',
  mouseData: 'int32',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t',
});
export const KEYBDINPUT = koffi.struct('RX_KEYBDINPUT', {
  wVk: 'uint16',
  wScan: 'uint16',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t',
});
export const HARDWAREINPUT = koffi.struct('RX_HARDWAREINPUT', {
  uMsg: 'uint32',
  wParamL: 'uint16',
  wParamH: 'uint16',
});
export const INPUT_UNION = koffi.union('RX_INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
export const INPUT = koffi.struct('RX_INPUT', { type: 'uint32', u: INPUT_UNION });
const POINT = koffi.struct('RX_POINT', { x: 'int32', y: 'int32' });
const RECT = koffi.struct('RX_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const GUITHREADINFO = koffi.struct('RX_GUITHREADINFO', {
  cbSize: 'uint32',
  flags: 'uint32',
  hwndActive: 'uintptr_t',
  hwndFocus: 'uintptr_t',
  hwndCapture: 'uintptr_t',
  hwndMenuOwner: 'uintptr_t',
  hwndMoveSize: 'uintptr_t',
  hwndCaret: 'uintptr_t',
  rcCaret: RECT,
});

export type WinInput = { type: number; u: { mi?: Record<string, number>; ki?: Record<string, number> } };

export function mouseInput(dwFlags: number, dx = 0, dy = 0, mouseData = 0): WinInput {
  return { type: INPUT_MOUSE, u: { mi: { dx, dy, mouseData, dwFlags, time: 0, dwExtraInfo: REMOTEX_EXTRA_INFO } } };
}

export function keyInput(wVk: number, wScan: number, dwFlags: number): WinInput {
  return { type: INPUT_KEYBOARD, u: { ki: { wVk, wScan, dwFlags, time: 0, dwExtraInfo: REMOTEX_EXTRA_INFO } } };
}

const BUTTON_FLAGS: Record<MouseButton, [number, number]> = {
  0: [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP],
  1: [MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP],
  2: [MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP],
};

/** Sequência de INPUTs para digitar texto Unicode (independe do layout de teclado do PC). */
export function textToInputs(text: string): WinInput[] {
  const out: WinInput[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a) {
      out.push(keyInput(VK_RETURN, 0x1c, 0), keyInput(VK_RETURN, 0x1c, KEYEVENTF_KEYUP));
    } else if (c === 0x09) {
      out.push(keyInput(VK_TAB, 0x0f, 0), keyInput(VK_TAB, 0x0f, KEYEVENTF_KEYUP));
    } else {
      out.push(keyInput(0, c, KEYEVENTF_UNICODE), keyInput(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
    }
  }
  return out;
}

export function wheelInputs(dx: number, dy: number): WinInput[] {
  const out: WinInput[] = [];
  if (dy) out.push(mouseInput(MOUSEEVENTF_WHEEL, 0, 0, -dy));
  if (dx) out.push(mouseInput(MOUSEEVENTF_HWHEEL, 0, 0, dx));
  return out;
}

export class WindowsInjector implements InputInjector {
  readonly name = 'windows-sendinput';
  private user32 = koffi.load('user32.dll');
  private kernel32 = koffi.load('kernel32.dll');
  private advapi32 = koffi.load('advapi32.dll');
  private SendInput = this.user32.func('uint32 __stdcall SendInput(uint32 cInputs, RX_INPUT *pInputs, int32 cbSize)');
  private GetSystemMetrics = this.user32.func('int32 __stdcall GetSystemMetrics(int32 nIndex)');
  private MapVirtualKeyW = this.user32.func('uint32 __stdcall MapVirtualKeyW(uint32 uCode, uint32 uMapType)');
  private GetCursorPos = this.user32.func('int32 __stdcall GetCursorPos(_Out_ RX_POINT *lpPoint)');
  private GetGUIThreadInfo = this.user32.func('int32 __stdcall GetGUIThreadInfo(uint32 idThread, _Inout_ RX_GUITHREADINFO *pgui)');
  private GetForegroundWindow = this.user32.func('uintptr_t __stdcall GetForegroundWindow()');
  private GetWindowThreadProcessId = this.user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32 *lpdwProcessId)');
  private OpenProcess = this.kernel32.func('uintptr_t __stdcall OpenProcess(uint32 access, int32 inherit, uint32 pid)');
  private CloseHandle = this.kernel32.func('int32 __stdcall CloseHandle(uintptr_t h)');
  private GetCurrentProcess = this.kernel32.func('uintptr_t __stdcall GetCurrentProcess()');
  private OpenProcessToken = this.advapi32.func('int32 __stdcall OpenProcessToken(uintptr_t proc, uint32 access, _Out_ uintptr_t *token)');
  private GetTokenInformation = this.advapi32.func(
    'int32 __stdcall GetTokenInformation(uintptr_t token, int32 cls, _Out_ uint32 *info, uint32 len, _Out_ uint32 *retLen)',
  );
  private scanCache = new Map<number, number>();
  private elevatedSelf: boolean | null = null;
  private lastForegroundCheck = 0;
  private lastForegroundElevated = false;

  private send(inputs: WinInput[]): InjectResult {
    if (inputs.length === 0) return { ok: true };
    const n = this.SendInput(inputs.length, inputs, koffi.sizeof(INPUT)) as number;
    if (n === inputs.length) return { ok: true };
    // SendInput não informa bloqueio por UIPI; verificamos se a janela ativa é elevada.
    return { ok: false, blocked: this.foregroundIsElevated(true) };
  }

  private virtualScreen(): Rect {
    return {
      x: this.GetSystemMetrics(SM_XVIRTUALSCREEN) as number,
      y: this.GetSystemMetrics(SM_YVIRTUALSCREEN) as number,
      width: this.GetSystemMetrics(SM_CXVIRTUALSCREEN) as number,
      height: this.GetSystemMetrics(SM_CYVIRTUALSCREEN) as number,
    };
  }

  moveTo(x: number, y: number): InjectResult {
    const { dx, dy } = toWindowsAbsolute(x, y, this.virtualScreen());
    return this.send([mouseInput(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, dx, dy)]);
  }

  button(b: MouseButton, down: boolean): InjectResult {
    const [d, u] = BUTTON_FLAGS[b];
    return this.withElevationCheck(this.send([mouseInput(down ? d : u)]));
  }

  wheel(dx: number, dy: number): InjectResult {
    return this.send(wheelInputs(dx, dy));
  }

  key(code: string, down: boolean): InjectResult {
    const def = keyDef(code);
    if (!def) return { ok: false };
    let scan = this.scanCache.get(def.vk);
    if (scan === undefined) {
      scan = (this.MapVirtualKeyW(def.vk, 0) as number) & 0xff;
      this.scanCache.set(def.vk, scan);
    }
    const flags = (def.ext ? KEYEVENTF_EXTENDEDKEY : 0) | (down ? 0 : KEYEVENTF_KEYUP);
    return this.withElevationCheck(this.send([keyInput(def.vk, scan, flags)]));
  }

  typeText(text: string): InjectResult {
    const inputs = textToInputs(text);
    let res: InjectResult = { ok: true };
    for (let i = 0; i < inputs.length; i += 400) {
      const r = this.send(inputs.slice(i, i + 400));
      if (!r.ok) res = r;
    }
    return this.withElevationCheck(res);
  }

  cursorPosition(): { x: number; y: number } | null {
    const p = { x: 0, y: 0 };
    return this.GetCursorPos(p) ? p : null;
  }

  caretActive(): boolean | null {
    const info: Record<string, unknown> = { cbSize: koffi.sizeof(GUITHREADINFO) };
    if (!this.GetGUIThreadInfo(0, info)) return null;
    return Boolean(info.hwndCaret);
  }

  /** true se o próprio host está rodando como administrador. */
  isElevated(): boolean {
    if (this.elevatedSelf === null) this.elevatedSelf = this.processElevated(this.GetCurrentProcess() as number, false) === true;
    return this.elevatedSelf;
  }

  /** Verifica (com cache de 1 s) se a janela em primeiro plano pertence a processo elevado. */
  foregroundIsElevated(force = false): boolean {
    const now = Date.now();
    if (!force && now - this.lastForegroundCheck < 1000) return this.lastForegroundElevated;
    this.lastForegroundCheck = now;
    if (this.isElevated()) return (this.lastForegroundElevated = false);
    const hwnd = this.GetForegroundWindow() as number;
    if (!hwnd) return (this.lastForegroundElevated = false);
    const pid = [0];
    this.GetWindowThreadProcessId(hwnd, pid);
    const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const h = this.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid[0]) as number;
    if (!h) return (this.lastForegroundElevated = true); // processo protegido/elevado
    try {
      return (this.lastForegroundElevated = this.processElevated(h, true) === true);
    } finally {
      this.CloseHandle(h);
    }
  }

  private processElevated(proc: number, _isForeign: boolean): boolean | null {
    const TOKEN_QUERY = 0x0008;
    const TokenElevation = 20;
    const tok = [0];
    if (!this.OpenProcessToken(proc, TOKEN_QUERY, tok)) return null;
    try {
      const info = [0];
      const len = [0];
      if (!this.GetTokenInformation(tok[0], TokenElevation, info, 4, len)) return null;
      return info[0] !== 0;
    } finally {
      this.CloseHandle(tok[0]);
    }
  }

  private withElevationCheck(r: InjectResult): InjectResult {
    if (r.ok && this.foregroundIsElevated()) return { ok: true, blocked: true };
    return r;
  }

  dispose(): void {
    /* bibliotecas do sistema permanecem carregadas pelo processo */
  }
}
