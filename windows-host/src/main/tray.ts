/** Ícone na bandeja: indica claramente que o acesso remoto está disponível/ativo. */
import { Menu, nativeImage, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { formatDeviceId } from '@remotex/shared/ids';
import type { HostStateView } from '../shared/ui-ipc';
import type { HostApp } from './host-app';

export class HostTray {
  private tray: Tray | null = null;

  constructor(private readonly host: HostApp) {}

  create(): void {
    const iconPath = path.join(__dirname, '..', 'assets', 'tray.png');
    const img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    try {
      this.tray = new Tray(img);
      this.tray.on('click', () => this.host.windows.showMain());
    } catch (err) {
      console.warn('[tray] bandeja do sistema indisponível', err);
    }
  }

  update(v: HostStateView): void {
    if (!this.tray) return;
    const statusText =
      v.status === 'online' ? (v.incomingEnabled ? 'Acesso remoto disponível' : 'Conexões remotas desativadas') : v.status === 'connecting' ? 'Conectando…' : 'Offline';
    const sessionText = v.session ? `Sessão ativa: ${v.session.clientName}` : null;
    this.tray.setToolTip(`RemoteX — ID ${formatDeviceId(v.deviceId || '')}\n${sessionText ?? statusText}`);
    const items: Electron.MenuItemConstructorOptions[] = [
      { label: `RemoteX — ID ${formatDeviceId(v.deviceId || '—')}`, enabled: false },
      { label: statusText, enabled: false },
    ];
    if (sessionText) items.push({ label: sessionText, enabled: false }, { label: 'Encerrar sessão', click: () => this.host.endSession('Encerrada no computador') });
    items.push(
      { type: 'separator' },
      { label: 'Abrir painel', click: () => this.host.windows.showMain() },
      { label: 'Permitir conexões remotas', type: 'checkbox', checked: v.incomingEnabled, click: (i) => this.host.setIncoming(i.checked) },
      { type: 'separator' },
      { label: 'Sair do RemoteX', click: () => this.host.quit() },
    );
    this.tray.setContextMenu(Menu.buildFromTemplate(items));
  }
}
