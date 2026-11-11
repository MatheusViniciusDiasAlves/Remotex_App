/** Ponto de entrada do RemoteX Host (processo principal do Electron). */
import { app } from 'electron';
import path from 'node:path';
import { HostApp } from './host-app';
import { installFileLogger } from './logger';

// Diretório de dados alternativo (testes automatizados / múltiplos perfis).
if (process.env.REMOTEX_USER_DATA) app.setPath('userData', process.env.REMOTEX_USER_DATA);
const logFile = installFileLogger(path.join(app.getPath('userData'), 'logs'));
console.log(`[remotex] RemoteX Host ${app.getVersion()} iniciando (${process.platform} ${process.arch}); log em ${logFile}`);

// Expõe endereços IP locais reais nos candidatos ICE (conexão direta na mesma rede Wi-Fi).
// Os candidatos só são enviados ao celular DEPOIS que o acesso foi autorizado.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

const isElevatedRelaunch = process.argv.includes('--elevated-relaunch');
const background = process.argv.includes('--background');

async function acquireLock(): Promise<boolean> {
  if (app.requestSingleInstanceLock()) return true;
  if (!isElevatedRelaunch) return false;
  // Reinício como administrador: aguarda a instância anterior liberar o bloqueio.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (app.requestSingleInstanceLock()) return true;
  }
  return false;
}

void (async () => {
  if (!(await acquireLock())) {
    app.quit();
    return;
  }
  if (process.platform === 'win32') app.setAppUserModelId('com.remotex.host');

  let host: HostApp | null = null;

  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--elevated-relaunch')) {
      host?.quit(); // a nova instância elevada assume
      return;
    }
    host?.windows.showMain();
  });

  app.on('window-all-closed', () => {
    // Mantém o processo vivo: a janela de mídia oculta continua aberta.
  });

  await app.whenReady();
  host = new HostApp({ background });
  host.windows.onMainClose = (e) => {
    if (host!.isQuitting) return;
    if (host!.store.get().runInBackground) {
      e.preventDefault();
      host!.windows.main?.hide();
    } else {
      host!.quit();
    }
  };
  app.on('before-quit', () => host?.store.flush());
  try {
    await host.start();
  } catch (err) {
    console.error('[remotex] falha ao iniciar o host', err);
  }
})();
