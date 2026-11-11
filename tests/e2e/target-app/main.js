/**
 * Aplicativo-alvo dos testes E2E: uma janela em tela cheia no Xvfb que registra (em stdout,
 * uma linha JSON por evento) tudo o que o RemoteX injeta no "computador": cliques, botões,
 * teclas, texto digitado, roda do mouse, movimentos e mudanças da área de transferência.
 * A área "pad" alterna entre preto e branco a cada clique para medir a latência ida-e-volta
 * (toque no celular → injeção → captura → codificação → rede → decodificação no celular).
 */
const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(() => {
  const win = new BrowserWindow({
    x: 0,
    y: 0,
    width: 1280,
    height: 800,
    frame: false,
    show: true,
    backgroundColor: '#202830',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  ipcMain.on('log', (_e, ev) => process.stdout.write(JSON.stringify({ ...ev, t: Date.now() }) + '\n'));
  let last = null;
  setInterval(async () => {
    try {
      const v = await clipboard.readText();
      if (last !== null && v !== last) process.stdout.write(JSON.stringify({ type: 'clipboard', text: v, t: Date.now() }) + '\n');
      last = v;
    } catch {}
  }, 300);
  process.stdout.write(JSON.stringify({ type: 'ready', t: Date.now() }) + '\n');
});
