/**
 * Integrações de plataforma do host: geometria de monitores, elevação de privilégios pelo
 * mecanismo oficial do Windows (UAC "runas"), bloqueio da estação e inicialização com o Windows.
 * Não há nenhum bypass de UAC: a elevação sempre exibe o consentimento do sistema operacional.
 */
import { app, screen, type Display } from 'electron';
import type { DisplayInfo } from '@remotex/media/channel-protocol';
import type { Rect } from '@remotex/capture/geometry';

export function physicalRect(d: Display): Rect {
  if (process.platform === 'win32') {
    const r = screen.dipToScreenRect(null, d.bounds);
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }
  const sf = d.scaleFactor || 1;
  return { x: Math.round(d.bounds.x * sf), y: Math.round(d.bounds.y * sf), width: Math.round(d.bounds.width * sf), height: Math.round(d.bounds.height * sf) };
}

export function listDisplays(): DisplayInfo[] {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => {
    const r = physicalRect(d);
    return {
      id: String(d.id),
      name: d.label || `Monitor ${i + 1}`,
      width: r.width,
      height: r.height,
      primary: d.id === primary,
    };
  });
}

export function findDisplay(id: string | null): Display {
  const all = screen.getAllDisplays();
  return all.find((d) => String(d.id) === id) ?? screen.getPrimaryDisplay();
}

let koffiMod: typeof import('koffi') | null = null;
async function koffi() {
  if (!koffiMod) koffiMod = await import('koffi');
  return koffiMod;
}

/**
 * Reinicia o host como administrador usando o consentimento oficial do UAC (ShellExecuteW "runas").
 * O prompt aparece na Área de Trabalho Segura do Windows e precisa ser aprovado por alguém
 * fisicamente no computador (ou por credenciais de administrador digitadas localmente).
 */
export async function relaunchElevated(): Promise<{ ok: boolean; message: string }> {
  if (process.platform !== 'win32') return { ok: false, message: 'Elevação via UAC só existe no Windows.' };
  const k = await koffi();
  const shell32 = k.load('shell32.dll');
  const ShellExecuteW = shell32.func('intptr_t __stdcall ShellExecuteW(intptr_t hwnd, str16 op, str16 file, str16 params, str16 dir, int32 show)');
  const args = [...process.argv.slice(1).filter((a) => !a.startsWith('--elevated-relaunch')), '--elevated-relaunch'];
  const params = args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
  const r = Number(ShellExecuteW(0, 'runas', process.execPath, params, null, 1));
  if (r > 32) return { ok: true, message: 'Consentimento do UAC aprovado. O RemoteX será reiniciado como administrador.' };
  if (r === 5) return { ok: false, message: 'O consentimento do UAC foi negado ou cancelado no computador.' };
  return { ok: false, message: `Não foi possível solicitar elevação (código ${r}).` };
}

export async function isProcessElevated(): Promise<boolean> {
  if (process.platform !== 'win32') return typeof process.getuid === 'function' && process.getuid() === 0;
  try {
    const k = await koffi();
    const shell32 = k.load('shell32.dll');
    const IsUserAnAdmin = shell32.func('int32 __stdcall IsUserAnAdmin()');
    return Boolean(IsUserAnAdmin());
  } catch {
    return false;
  }
}

/** Bloqueia a estação de trabalho (equivalente a Win+L, via API oficial LockWorkStation). */
export async function lockWorkstation(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const k = await koffi();
  const user32 = k.load('user32.dll');
  const LockWorkStation = user32.func('int32 __stdcall LockWorkStation()');
  return Boolean(LockWorkStation());
}

export function setLaunchAtStartup(enabled: boolean): void {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--background'] });
  }
}
