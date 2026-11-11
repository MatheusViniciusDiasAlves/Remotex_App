/** Janelas do host: painel, aprovação de acesso, banner de sessão ativa e janela de mídia oculta. */
import { app, BrowserWindow, screen, type WebContents } from 'electron';
import path from 'node:path';

const DIST = path.join(__dirname);
const PRELOAD_UI = path.join(DIST, 'preload', 'ui-preload.js');
const PRELOAD_ENGINE = path.join(DIST, 'preload', 'engine-preload.js');
const UI_HTML = path.join(DIST, 'renderer', 'ui.html');
const ENGINE_HTML = path.join(DIST, 'renderer', 'engine.html');
export const ICON = path.join(DIST, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

function harden(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

export class HostWindows {
  engine: BrowserWindow | null = null;
  main: BrowserWindow | null = null;
  banner: BrowserWindow | null = null;
  private approvals = new Map<string, BrowserWindow>();
  onMainClose: (e: Electron.Event) => void = () => undefined;

  createEngine(): void {
    this.engine = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      webPreferences: {
        preload: PRELOAD_ENGINE,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    harden(this.engine);
    void this.engine.loadFile(ENGINE_HTML);
    this.engine.on('closed', () => (this.engine = null));
  }

  showMain(): void {
    if (this.main && !this.main.isDestroyed()) {
      if (this.main.isMinimized()) this.main.restore();
      this.main.show();
      this.main.focus();
      return;
    }
    this.main = new BrowserWindow({
      width: 1100,
      height: 760,
      minWidth: 880,
      minHeight: 600,
      title: 'RemoteX Host',
      icon: ICON,
      backgroundColor: '#0b1220',
      autoHideMenuBar: true,
      show: false,
      webPreferences: { preload: PRELOAD_UI, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    harden(this.main);
    this.main.once('ready-to-show', () => this.main?.show());
    this.main.on('close', (e) => this.onMainClose(e));
    this.main.on('closed', () => (this.main = null));
    void this.main.loadFile(UI_HTML, { query: { view: 'main' } });
  }

  showApproval(sessionId: string): void {
    const existing = this.approvals.get(sessionId);
    if (existing && !existing.isDestroyed()) return existing.focus();
    const win = new BrowserWindow({
      width: 480,
      height: 690,
      resizable: false,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      title: 'RemoteX — Pedido de acesso',
      icon: ICON,
      backgroundColor: '#0b1220',
      autoHideMenuBar: true,
      show: false,
      webPreferences: { preload: PRELOAD_UI, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    harden(win);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.once('ready-to-show', () => {
      win.show();
      win.focus();
      win.flashFrame(true);
    });
    win.on('closed', () => this.approvals.delete(sessionId));
    this.approvals.set(sessionId, win);
    void win.loadFile(UI_HTML, { query: { view: 'approval', session: sessionId } });
  }

  closeApproval(sessionId: string): void {
    const w = this.approvals.get(sessionId);
    this.approvals.delete(sessionId);
    if (w && !w.isDestroyed()) w.destroy();
  }

  /** Banner sempre visível indicando que o computador está sendo acessado remotamente. */
  showBanner(): void {
    if (this.banner && !this.banner.isDestroyed()) {
      this.banner.showInactive();
      return;
    }
    const wa = screen.getPrimaryDisplay().workArea;
    const width = 620;
    this.banner = new BrowserWindow({
      width,
      height: 58,
      x: Math.round(wa.x + (wa.width - width) / 2),
      y: wa.y + 6,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true,
      show: false,
      backgroundColor: '#111827',
      webPreferences: { preload: PRELOAD_UI, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    harden(this.banner);
    this.banner.setAlwaysOnTop(true, 'screen-saver');
    this.banner.setVisibleOnAllWorkspaces(true);
    this.banner.once('ready-to-show', () => this.banner?.showInactive());
    this.banner.on('closed', () => (this.banner = null));
    void this.banner.loadFile(UI_HTML, { query: { view: 'banner' } });
  }

  hideBanner(): void {
    if (this.banner && !this.banner.isDestroyed()) this.banner.destroy();
    this.banner = null;
  }

  private uiWindows(): BrowserWindow[] {
    return [this.main, this.banner, ...this.approvals.values()].filter((w): w is BrowserWindow => Boolean(w && !w.isDestroyed()));
  }

  broadcast(channel: string, data: unknown): void {
    for (const w of this.uiWindows()) w.webContents.send(channel, data);
  }

  isUiSender(sender: WebContents): boolean {
    return this.uiWindows().some((w) => w.webContents === sender);
  }

  destroyAll(): void {
    for (const w of [...this.uiWindows(), this.engine]) if (w && !w.isDestroyed()) w.destroy();
    app.quit();
  }
}
