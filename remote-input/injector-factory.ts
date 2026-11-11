/** Seleciona o injetor de entrada adequado ao sistema operacional do host. */
import type { InputInjector } from './injector';
import { RecordingInjector } from './injector';

export async function createInjector(): Promise<InputInjector> {
  if (process.platform === 'win32') {
    const { WindowsInjector } = await import('./windows-injector');
    return new WindowsInjector();
  }
  if (process.platform === 'linux' && process.env.DISPLAY) {
    const { LinuxX11Injector } = await import('./linux-injector');
    return new LinuxX11Injector();
  }
  console.warn('[remotex] plataforma sem injetor de entrada suportado; controle remoto desativado');
  return new RecordingInjector();
}
