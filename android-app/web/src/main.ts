/** Ponto de entrada do aplicativo RemoteX (celular). */
import { App } from './ui/app';

const root = document.getElementById('app')!;
const app = new App(root);
(window as any).remotexApp = app;

// Botão "voltar" do Android (chamado pelo shell nativo): fecha folhas/teclado antes de sair.
(window as any).remotexBack = (): boolean => {
  const sheet = document.querySelector('.sheet-backdrop');
  if (sheet) {
    (sheet.querySelector('.sheet-head .icon-btn') as HTMLButtonElement | null)?.click();
    return true;
  }
  if (document.body.classList.contains('in-session')) {
    (document.querySelector('[data-testid="tool-disconnect"]') as HTMLButtonElement | null)?.click();
    return true;
  }
  return false;
};
