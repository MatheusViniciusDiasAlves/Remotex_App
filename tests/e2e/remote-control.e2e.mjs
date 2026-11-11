#!/usr/bin/env node
/**
 * TESTE PONTA A PONTA DO REMOTEX (sem simulações):
 *
 *   servidor real (Node + PostgreSQL)  ←→  host RemoteX real (Electron, captura de tela real
 *   do Xvfb, injeção de entrada real via XTest)  ←→  cliente móvel real (Chromium emulando um
 *   Pixel 7 com tela de toque) conectado por WebRTC.
 *
 * Um aplicativo-alvo em tela cheia no "computador" registra tudo o que recebe; as asserções
 * conferem que toques/teclado/rolagem feitos no "celular" chegaram ao computador corretamente.
 *
 * Execução: npm run test:e2e   (requer Xvfb, PostgreSQL e Chromium do Playwright)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = require('/opt/node-tools/node_modules/playwright');
}
const { chromium, _electron, devices } = pw;

const PORT = Number(process.env.E2E_PORT || 18090);
const BASE = `http://127.0.0.1:${PORT}`;
const ELECTRON = path.join(root, 'windows-host/node_modules/electron/dist/electron');
const ART = path.join(root, 'tests/e2e/.artifacts');
fs.rmSync(ART, { recursive: true, force: true });
fs.mkdirSync(ART, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remotex-e2e-'));

const results = [];
const metrics = {};
const procs = [];
let failed = 0;

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_OPTIONS; // Electron não aceita --use-openssl-ca
  return env;
}

function log(...a) {
  console.log(`[e2e ${new Date().toISOString().slice(11, 23)}]`, ...a);
}

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    log(`✔ ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failed++;
    results.push({ name, ok: false, ms: Date.now() - t0, error: String(err?.stack || err) });
    log(`✘ ${name}: ${err?.message || err}`);
    throw err;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Falha: ${msg}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 15000, interval = 100, what = 'condição') {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`tempo esgotado esperando ${what}`);
}

// ------------------------------------------------------------------------------------------
// Processos auxiliares
// ------------------------------------------------------------------------------------------
function startServer() {
  const p = spawn(process.execPath, [path.join(root, 'dist/server/server.js')], {
    env: cleanEnv({ PORT: String(PORT), HOST: '127.0.0.1', JWT_SECRET: 'e2e'.repeat(15), PUBLIC_DIR: path.join(root, 'android-app/web/dist') }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = fs.createWriteStream(path.join(ART, 'server.log'));
  p.stdout.pipe(out);
  p.stderr.pipe(out);
  procs.push(p);
  return p;
}

class TargetApp {
  events = [];
  constructor() {
    this.proc = spawn(ELECTRON, ['--no-sandbox', path.join(root, 'tests/e2e/target-app')], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(this.proc);
    const errLog = fs.createWriteStream(path.join(ART, 'target.stderr.log'));
    this.proc.stderr.pipe(errLog);
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      try {
        this.events.push(JSON.parse(line));
      } catch {
        /* linhas não-JSON */
      }
    });
  }
  find(pred, since = 0) {
    return this.events.find((e) => e.t >= since && pred(e));
  }
  wait(pred, timeout = 10000, what = 'evento no computador', since = 0) {
    return waitFor(() => this.find(pred, since), timeout, 30, what);
  }
  last(type) {
    return [...this.events].reverse().find((e) => e.type === type);
  }
}

// ------------------------------------------------------------------------------------------
// Utilidades do cliente (celular emulado)
// ------------------------------------------------------------------------------------------
async function newPhone(browser, name) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'pt-BR', permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') fs.appendFileSync(path.join(ART, `${name}.console.log`), `${m.text()}\n`);
  });
  await page.goto(BASE + '/');
  await page.waitForSelector('[data-testid=server-dot][data-status=online]', { timeout: 20000 });
  const cdp = await ctx.newCDPSession(page);
  return { ctx, page, cdp, name };
}

async function connectPhone(phone, hostId) {
  await phone.page.click('[data-testid=tab-home]');
  await phone.page.fill('[data-testid=host-id-input]', hostId);
  try {
    await phone.page.waitForSelector('[data-testid=connect-btn]:not([disabled])', { timeout: 3000 });
  } catch {
    const v = await phone.page.inputValue('[data-testid=host-id-input]');
    await phone.page.screenshot({ path: path.join(ART, `${phone.name}-connect-disabled.png`) });
    log(`botão desabilitado; campo="${v}" esperado="${hostId}"`);
    throw new Error(`botão Conectar desabilitado (campo="${v}")`);
  }
  await phone.page.click('[data-testid=connect-btn]');
}

async function waitConnected(phone, timeout = 30000) {
  await phone.page.waitForSelector('[data-testid=conn-overlay]', { state: 'hidden', timeout });
}

async function remoteToPage(page, x, y) {
  return page.evaluate(
    ([x, y]) => {
      const v = document.querySelector('[data-testid=remote-video]');
      const r = v.getBoundingClientRect();
      return { x: r.left + (x / 1279) * r.width, y: r.top + (y / 799) * r.height };
    },
    [x, y],
  );
}

async function countFrames(page, n = 15, timeout = 10000) {
  return page.evaluate(
    ([n, timeout]) =>
      new Promise((res) => {
        const v = document.querySelector('[data-testid=remote-video]');
        let c = 0;
        const t0 = performance.now();
        const cb = () => {
          if (++c >= n) res({ frames: c, ms: performance.now() - t0, w: v.videoWidth, h: v.videoHeight });
          else v.requestVideoFrameCallback(cb);
        };
        v.requestVideoFrameCallback(cb);
        setTimeout(() => res({ frames: c, ms: performance.now() - t0, w: v.videoWidth, h: v.videoHeight }), timeout);
      }),
    [n, timeout],
  );
}

async function touch(cdp, type, pts) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i + 1, radiusX: 3, radiusY: 3, force: 1 })),
  });
}

async function longPress(cdp, p, ms = 750) {
  await touch(cdp, 'touchStart', [p]);
  await sleep(ms);
  await touch(cdp, 'touchEnd', []);
}

async function drag(cdp, from, to, steps = 12, stepMs = 16) {
  await touch(cdp, 'touchStart', [from]);
  for (let i = 1; i <= steps; i++) {
    await touch(cdp, 'touchMove', [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }]);
    await sleep(stepMs);
  }
  await touch(cdp, 'touchEnd', []);
}

async function twoFingerSwipe(cdp, center, dy, steps = 10) {
  const a = { x: center.x - 40, y: center.y };
  const b = { x: center.x + 40, y: center.y };
  await touch(cdp, 'touchStart', [a, b]);
  for (let i = 1; i <= steps; i++) {
    const d = (dy * i) / steps;
    await touch(cdp, 'touchMove', [{ x: a.x, y: a.y + d }, { x: b.x, y: b.y + d }]);
    await sleep(20);
  }
  await touch(cdp, 'touchEnd', []);
}

/** Liga/desliga um interruptor estilizado clicando nele (como o usuário). */
async function setSwitch(page, testid, value) {
  const input = page.locator(`[data-testid=${testid}]`);
  if ((await input.isChecked()) !== value) await page.locator(`label:has([data-testid=${testid}])`).click();
  await waitFor(async () => (await input.isChecked()) === value, 5000, 100, `interruptor ${testid}`);
}

/** Clica em botão que fecha a própria janela (a janela pode sumir antes do fim da ação). */
async function clickClosing(page, selector) {
  await page.click(selector, { noWaitAfter: true }).catch((e) => {
    if (!/closed/i.test(String(e))) throw e;
  });
}

async function closeSheet(page) {
  await page.click('.sheet-head .icon-btn');
  await page.waitForSelector('.sheet-backdrop', { state: 'detached', timeout: 3000 });
}

async function openToolbar(page) {
  await page.click('[data-testid=toolbar-handle]');
  await page.waitForSelector('[data-testid=toolbar].visible');
}

/** Mede a latência ida-e-volta: toque na área "pad" → cor muda no vídeo recebido. */
async function measureRoundTrip(phone, padCenter) {
  const pageXY = await remoteToPage(phone.page, padCenter.x, padCenter.y);
  const flip = phone.page.evaluate(
    ([px, py]) =>
      new Promise((res) => {
        const v = document.querySelector('[data-testid=remote-video]');
        const c = document.createElement('canvas');
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        const sample = () => {
          ctx.drawImage(v, 0, 0);
          return ctx.getImageData(Math.round((px * v.videoWidth) / 1280), Math.round((py * v.videoHeight) / 800), 1, 1).data[0];
        };
        const initial = sample() > 128;
        const t0 = Date.now();
        const cb = () => {
          const now = sample() > 128;
          if (now !== initial) return res({ t: Date.now(), initial });
          if (Date.now() - t0 > 5000) return res({ t: -1, initial });
          v.requestVideoFrameCallback(cb);
        };
        v.requestVideoFrameCallback(cb);
      }),
    [padCenter.x, padCenter.y],
  );
  await sleep(150);
  const t0 = Date.now();
  await phone.page.touchscreen.tap(pageXY.x, pageXY.y);
  const r = await flip;
  return r.t > 0 ? r.t - t0 : null;
}

// ------------------------------------------------------------------------------------------
// Execução
// ------------------------------------------------------------------------------------------
let host;
let hostPage;
let browser;
let target;

async function main() {
  log('diretório temporário', tmp);
  startServer();
  await waitFor(async () => {
    try {
      return (await fetch(BASE + '/api/health')).ok;
    } catch {
      return false;
    }
  }, 20000, 200, 'servidor');

  await step('Host Windows (Electron) inicia, registra-se e fica online', async () => {
    host = await _electron.launch({
      executablePath: ELECTRON,
      args: ['--no-sandbox', path.join(root, 'windows-host')],
      env: cleanEnv({ REMOTEX_SERVER: BASE, REMOTEX_USER_DATA: path.join(tmp, 'host'), REMOTEX_DEBUG_INPUT: '1' }),
      timeout: 30000,
    });
    host.process().stderr?.pipe(fs.createWriteStream(path.join(ART, 'host.stderr.log')));
    host.process().stdout?.pipe(fs.createWriteStream(path.join(ART, 'host.stdout.log')));
    hostPage = await waitFor(() => host.windows().find((w) => w.url().includes('view=main')), 20000, 200, 'janela do painel');
    await hostPage.waitForSelector('[data-testid=host-status]:text("Online")', { timeout: 20000 });
  });

  const hostId = (await hostPage.textContent('[data-testid=host-id]')).replace(/\D/g, '');
  log('ID do computador:', hostId);
  assert(/^\d{9}$/.test(hostId), 'ID de 9 dígitos');

  target = new TargetApp();
  await target.wait((e) => e.type === 'ready', 15000, 'app-alvo');
  await sleep(1200);

  browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'] });
  const phoneA = await newPhone(browser, 'celularA');
  await phoneA.page.screenshot({ path: path.join(ART, 'phone-home.png') });

  // ==== A: aprovação manual, controle completo ===========================================
  await step('A1 celular pede acesso e aparece a janela de aprovação no computador', async () => {
    await connectPhone(phoneA, hostId);
    await phoneA.page.waitForSelector('[data-testid=phase-text]:text("Aguardando aprovação")', { timeout: 20000 });
    const approval = await waitFor(() => host.windows().find((w) => w.url().includes('view=approval')), 15000, 100, 'janela de aprovação');
    await approval.waitForSelector('[data-testid=approve-accept]');
    await approval.screenshot({ path: path.join(ART, 'host-approval.png') });
    const name = await approval.textContent('[data-testid=approve-name]');
    assert(name && name.length > 0, 'nome do celular na aprovação');
    await approval.check('[data-testid=approve-perm-recording]', { force: true });
    await approval.check('[data-testid=approve-perm-admin]', { force: true });
    await approval.check('[data-testid=approve-trust]', { force: true });
    await approval.check('[data-testid=approve-unattended]', { force: true });
    await clickClosing(approval, '[data-testid=approve-accept]');
  });

  await step('A2 sessão estabelecida: vídeo real da tela do computador chega ao celular', async () => {
    await waitConnected(phoneA);
    const f = await countFrames(phoneA.page, 15);
    log('quadros recebidos', f);
    assert(f.frames >= 10, `quadros de vídeo recebidos (${f.frames})`);
    assert(f.w === 1280 && f.h === 800, `resolução do vídeo ${f.w}x${f.h}`);
    metrics.videoResolution = `${f.w}x${f.h}`;
    await phoneA.page.screenshot({ path: path.join(ART, 'phone-session.png') });
  });

  await step('A3 códigos de verificação (anti-interceptação) iguais no PC e no celular', async () => {
    const hostSas = (await hostPage.waitForSelector('[data-testid=session-sas]')).textContent();
    await openToolbar(phoneA.page);
    await phoneA.page.screenshot({ path: path.join(ART, 'phone-toolbar.png') });
    await phoneA.page.click('[data-testid=tool-settings]');
    await phoneA.page.screenshot({ path: path.join(ART, 'phone-session-info.png') });
    const phoneSas = await phoneA.page.textContent('[data-testid=info-sas]');
    assert((await hostSas) === phoneSas, `SAS host=${await hostSas} celular=${phoneSas}`);
    metrics.sas = phoneSas;
    await closeSheet(phoneA.page);
    const state = await hostPage.textContent('[data-testid=session-state]');
    assert(/verificado/.test(state), `estado da sessão no host: ${state}`);
  });

  await step('A4 toque simples = clique esquerdo no ponto exato (modo Touch)', async () => {
    const p = await remoteToPage(phoneA.page, 400, 350);
    const since = Date.now();
    await phoneA.page.touchscreen.tap(p.x, p.y);
    const ev = await target.wait((e) => e.type === 'mousedown' && e.button === 0, 5000, 'clique', since);
    metrics.inputLatencyMs = ev.t - since;
    assert(Math.abs(ev.x - 400) <= 4 && Math.abs(ev.y - 350) <= 4, `posição do clique ${ev.x},${ev.y}`);
    assert(ev.target === 't', 'clique no campo de texto');
  });

  await step('A5 teclado nativo: texto com acentos (pt-BR) digitado no computador', async () => {
    await openToolbar(phoneA.page);
    await phoneA.page.click('[data-testid=tool-keyboard]');
    await phoneA.page.waitForSelector('[data-testid=keybar].visible');
    await phoneA.page.keyboard.type('Olá RemoteX! ação ç 123');
    await sleep(300);
    await phoneA.page.screenshot({ path: path.join(ART, 'phone-keyboard.png') });
    const v = await target.wait((e) => e.type === 'value' && e.value === 'Olá RemoteX! ação ç 123', 8000, 'texto digitado');
    assert(v, 'texto exato no computador');
  });

  await step('A6 barra de teclas especiais: Backspace, Enter e atalho Ctrl+A', async () => {
    await phoneA.page.click('[data-testid=key-Backspace]');
    await target.wait((e) => e.type === 'value' && e.value === 'Olá RemoteX! ação ç 12', 5000, 'backspace');
    await phoneA.page.click('[data-testid=key-Enter]');
    await target.wait((e) => e.type === 'value' && e.value === 'Olá RemoteX! ação ç 12\n', 5000, 'enter');
    const since = Date.now();
    await phoneA.page.click('[data-testid=mod-ControlLeft]');
    await phoneA.page.keyboard.type('a');
    await target.wait((e) => e.type === 'keydown' && e.code === 'KeyA' && e.ctrl, 5000, 'Ctrl+A', since);
    await phoneA.page.click('[data-testid=key-ArrowLeft]');
    await target.wait((e) => e.type === 'keydown' && e.key === 'ArrowLeft', 5000, 'seta');
  });

  await step('A7 toque prolongado = clique direito', async () => {
    await phoneA.page.click('.keybar [aria-label="Fechar teclado"]');
    await sleep(500); // layout volta a ocupar a tela inteira
    const p = await remoteToPage(phoneA.page, 970, 350);
    const since = Date.now();
    await longPress(phoneA.cdp, p, 800);
    const ev = await target.wait((e) => e.type === 'contextmenu', 5000, 'menu de contexto', since);
    assert(ev.target === 'zone' && Math.abs(ev.x - 970) <= 5 && Math.abs(ev.y - 350) <= 5, `clique direito em ${ev.x},${ev.y}`);
  });

  await step('A8 duplo toque = duplo clique', async () => {
    const p = await remoteToPage(phoneA.page, 1000, 300);
    const since = Date.now();
    await phoneA.page.touchscreen.tap(p.x, p.y);
    await sleep(90);
    await phoneA.page.touchscreen.tap(p.x, p.y);
    await target.wait((e) => e.type === 'dblclick', 5000, 'duplo clique', since);
  });

  await step('A9 arrastar com um dedo = arrastar com botão pressionado', async () => {
    const from = await remoteToPage(phoneA.page, 800, 260);
    const to = await remoteToPage(phoneA.page, 1100, 420);
    const since = Date.now();
    await drag(phoneA.cdp, from, to, 15, 20);
    const down = await target.wait((e) => e.type === 'mousedown' && e.button === 0, 5000, 'início do arraste', since);
    const moved = await target.wait((e) => e.type === 'mousemove' && e.buttons === 1, 5000, 'movimento com botão', since);
    const up = await target.wait((e) => e.type === 'mouseup' && e.button === 0, 5000, 'fim do arraste', since);
    assert(Math.abs(down.x - 800) <= 6 && Math.abs(up.x - 1100) <= 6 && Math.abs(up.y - 420) <= 6, `arraste ${down.x},${down.y} → ${up.x},${up.y}`);
    assert(moved, 'movimento intermediário');
  });

  await step('A10 dois dedos = rolagem vertical', async () => {
    const c = await remoteToPage(phoneA.page, 970, 650);
    const since = Date.now();
    await twoFingerSwipe(phoneA.cdp, c, -160);
    const ev = await target.wait((e) => e.type === 'wheel' && e.dy > 0, 5000, 'rolagem', since);
    assert(ev.target === 'scroll' || ev.target === '', `rolagem sobre a área correta (${ev.target})`);
  });

  await step('A11 modo Mouse (touchpad): deslizar move o cursor, toque clica na posição do cursor', async () => {
    await openToolbar(phoneA.page);
    await phoneA.page.click('[data-testid=tool-mode]');
    await phoneA.page.waitForSelector('[data-testid=mouse-0]');
    // posiciona o cursor numa referência conhecida com um toque no modo touch anterior
    const since = Date.now();
    const start = await remoteToPage(phoneA.page, 640, 400);
    await drag(phoneA.cdp, start, { x: start.x + 60, y: start.y + 30 }, 10, 25);
    const moved = await target.wait((e) => e.type === 'mousemove' && e.buttons === 0, 5000, 'cursor movido', since);
    assert(moved, 'cursor se moveu');
    const s2 = Date.now();
    await phoneA.page.touchscreen.tap(start.x - 100, start.y - 100);
    const click = await target.wait((e) => e.type === 'mousedown' && e.button === 0, 5000, 'clique no cursor', s2);
    // o clique deve acontecer na posição do cursor (último movimento), não no ponto tocado
    const lastMove = [...target.events].reverse().find((e) => e.type === 'mousemove' && e.t <= click.t && e.t >= since);
    const tapped = await phoneA.page.evaluate(([x, y]) => {
      const r = document.querySelector('[data-testid=remote-video]').getBoundingClientRect();
      return { x: ((x - r.left) / r.width) * 1279, y: ((y - r.top) / r.height) * 799 };
    }, [start.x - 100, start.y - 100]);
    assert(lastMove && Math.abs(click.x - lastMove.x) <= 15 && Math.abs(click.y - lastMove.y) <= 15, `clique (${click.x},${click.y}) na posição do cursor (${lastMove?.x},${lastMove?.y})`);
    assert(Math.hypot(click.x - tapped.x, click.y - tapped.y) > 60, 'clique não ocorre no ponto onde o dedo tocou');
    // botão direito da barra do modo mouse
    const s3 = Date.now();
    await phoneA.page.locator('[data-testid=mouse-2]').dispatchEvent('pointerdown');
    await phoneA.page.locator('[data-testid=mouse-2]').dispatchEvent('pointerup');
    await target.wait((e) => e.type === 'mouseup' && e.button === 2, 5000, 'botão direito da barra', s3);
    await openToolbar(phoneA.page);
    await phoneA.page.click('[data-testid=tool-mode]');
  });

  await step('A12 zoom com pinça e modo Resolução original preservam a proporção', async () => {
    const before = await phoneA.page.evaluate(() => {
      const r = document.querySelector('[data-testid=remote-video]').getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    const c = await remoteToPage(phoneA.page, 640, 400);
    await touch(phoneA.cdp, 'touchStart', [{ x: c.x - 30, y: c.y }, { x: c.x + 30, y: c.y }]);
    for (let i = 1; i <= 10; i++) {
      await touch(phoneA.cdp, 'touchMove', [{ x: c.x - 30 - i * 12, y: c.y }, { x: c.x + 30 + i * 12, y: c.y }]);
      await sleep(16);
    }
    await touch(phoneA.cdp, 'touchEnd', []);
    const after = await phoneA.page.evaluate(() => {
      const r = document.querySelector('[data-testid=remote-video]').getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    assert(after.w > before.w * 1.5, `zoom aplicado (${before.w.toFixed(0)} → ${after.w.toFixed(0)})`);
    assert(Math.abs(after.w / after.h - 1.6) < 0.01, 'proporção 16:10 preservada (sem distorção)');
    // um toque com zoom continua clicando no ponto certo
    const p = await remoteToPage(phoneA.page, 640, 400);
    const since = Date.now();
    await phoneA.page.touchscreen.tap(p.x, p.y);
    const ev = await target.wait((e) => e.type === 'mousedown', 5000, 'clique com zoom', since);
    assert(Math.abs(ev.x - 640) <= 3 && Math.abs(ev.y - 400) <= 3, `clique preciso com zoom (${ev.x},${ev.y})`);
    await openToolbar(phoneA.page);
    await phoneA.page.click('[data-testid=tool-view]'); // Resolução original
    await sleep(300);
    const orig = await phoneA.page.evaluate(() => {
      const v = document.querySelector('[data-testid=remote-video]');
      return { cssW: v.getBoundingClientRect().width, dpr: devicePixelRatio, vw: v.videoWidth };
    });
    assert(Math.abs(orig.cssW * orig.dpr - 1280) < 2, `1 px do PC = 1 px físico (${(orig.cssW * orig.dpr).toFixed(1)})`);
    await openToolbar(phoneA.page);
    await phoneA.page.click('[data-testid=tool-view]'); // volta para Tela completa
  });

  await step('A13 área de transferência: celular → computador', async () => {
    await openToolbar(phoneA.page);
    await phoneA.page.click('[data-testid=tool-clipboard]');
    await phoneA.page.fill('[data-testid=clip-text]', 'texto do celular 📋');
    const since = Date.now();
    await phoneA.page.click('[data-testid=clip-send]');
    await target.wait((e) => e.type === 'clipboard' && e.text === 'texto do celular 📋', 5000, 'área de transferência do PC', since);
    await closeSheet(phoneA.page);
  });

  await step('A14 atalhos: Ctrl+Alt+Del recebe aviso honesto de limitação do Windows', async () => {
    await openToolbar(phoneA.page);
    await phoneA.page.click('[data-testid=tool-shortcuts]');
    await phoneA.page.click('[data-testid="shortcut-Sequência de segurança"]');
    await phoneA.page.waitForSelector('[data-testid=toast]:has-text("Ctrl+Alt+Del")', { timeout: 5000 });
  });

  await step('A15 latência ida-e-volta medida pelo vídeo (toque → PC → tela de volta no celular)', async () => {
    const samples = [];
    for (let i = 0; i < 7; i++) {
      const ms = await measureRoundTrip(phoneA, { x: 200, y: 660 });
      if (ms !== null) samples.push(ms);
      await sleep(250);
    }
    samples.sort((a, b) => a - b);
    assert(samples.length >= 5, `amostras de latência (${samples.length})`);
    metrics.roundTripMs = { median: samples[Math.floor(samples.length / 2)], min: samples[0], max: samples.at(-1), samples };
    log('latência ida-e-volta (ms):', metrics.roundTripMs);
  });

  await step('A16 gravação no computador com indicador visível', async () => {
    const recStart = Date.now();
    await openToolbar(phoneA.page);
    await phoneA.page.click('[data-testid=tool-record]');
    await phoneA.page.click('[data-testid=rec-target] [data-value=host]');
    await phoneA.page.click('[data-testid=rec-start]');
    await phoneA.page.waitForSelector('[data-testid=rec-indicator]:visible', { timeout: 8000 });
    await hostPage.waitForSelector('.alert.rec', { timeout: 8000 });
    await sleep(3500);
    await openToolbar(phoneA.page);
    await phoneA.page.click('[data-testid=tool-record]');
    await phoneA.page.click('[data-testid=rec-stop]');
    await phoneA.page.waitForSelector('[data-testid=toast]:has-text("Gravação salva no computador")', { timeout: 10000 });
    const dir = path.join(os.homedir(), 'Videos', 'RemoteX');
    const files = await waitFor(() => {
      const list = fs.existsSync(dir)
        ? fs.readdirSync(dir).map((f) => ({ f, s: fs.statSync(path.join(dir, f)).size, m: fs.statSync(path.join(dir, f)).mtimeMs }))
        : [];
      const fresh = list.filter((x) => x.s > 10_000 && x.m >= recStart);
      return fresh.length ? fresh : null;
    }, 8000, 200, 'arquivo de gravação desta execução');
    const best = files.sort((a, b) => b.m - a.m)[0];
    metrics.recording = best;
    log('gravação:', best);
  });

  await step('A17 painel administrativo remoto lista o dispositivo confiável', async () => {
    await openToolbar(phoneA.page);
    await phoneA.page.click('[data-testid=tool-admin]');
    await phoneA.page.waitForSelector('[data-testid=admin-sheet] .admin-device', { timeout: 8000 });
    await closeSheet(phoneA.page);
  });

  await step('A18 desconectar encerra a sessão nos dois lados', async () => {
    await openToolbar(phoneA.page);
    await phoneA.page.click('[data-testid=tool-disconnect]');
    await phoneA.page.click('[data-testid=dialog-ok]');
    await phoneA.page.waitForSelector('[data-testid=end-reason]', { timeout: 8000 });
    await hostPage.waitForSelector('[data-testid=session-card]', { state: 'detached', timeout: 8000 });
    await phoneA.page.click('text=Voltar');
  });

  // ==== B: senha de acesso não assistido =================================================
  await step('B1 dono define senha de acesso e ativa acesso não assistido', async () => {
    await hostPage.click('[data-testid=nav-security]');
    await setSwitch(hostPage, 'toggle-unattended', true);
    await hostPage.fill('[data-testid=pw-new]', 'Senha-Forte-2026');
    await hostPage.fill('[data-testid=pw-confirm]', 'Senha-Forte-2026');
    await hostPage.click('[data-testid=pw-save]');
    await hostPage.waitForSelector('[data-testid=pw-status]:text("Definida")', { timeout: 10000 });
    await hostPage.click('[data-testid=nav-home]');
  });

  const phoneB = await newPhone(browser, 'celularB');
  await step('B2 senha errada é recusada; senha correta conecta sem aprovação', async () => {
    await connectPhone(phoneB, hostId);
    await phoneB.page.waitForSelector('[data-testid=auth-password]', { timeout: 20000 });
    await phoneB.page.screenshot({ path: path.join(ART, 'phone-password.png') });
    await phoneB.page.fill('[data-testid=auth-password]', 'senha-errada-1');
    await phoneB.page.click('[data-testid=auth-submit]');
    await phoneB.page.waitForSelector('[data-testid=auth-error]', { timeout: 10000 });
    await phoneB.page.fill('[data-testid=auth-password]', 'Senha-Forte-2026');
    await phoneB.page.check('[data-testid=auth-remember]');
    await phoneB.page.click('[data-testid=auth-submit]');
    await waitConnected(phoneB);
    const f = await countFrames(phoneB.page, 10);
    assert(f.frames >= 8, 'vídeo na sessão por senha');
    const p = await remoteToPage(phoneB.page, 300, 300);
    const since = Date.now();
    await phoneB.page.touchscreen.tap(p.x, p.y);
    await target.wait((e) => e.type === 'mousedown' && Math.abs(e.x - 300) <= 4, 5000, 'clique na sessão por senha', since);
    await openToolbar(phoneB.page);
    await phoneB.page.click('[data-testid=tool-disconnect]');
    await phoneB.page.click('[data-testid=dialog-ok]');
    await phoneB.page.waitForSelector('[data-testid=end-reason]');
    await phoneB.page.click('text=Voltar');
  });

  await step('B3 senha lembrada (chave derivada) reconecta sem digitar', async () => {
    await hostPage.waitForSelector('[data-testid=session-card]', { state: 'detached', timeout: 8000 });
    await connectPhone(phoneB, hostId);
    await waitConnected(phoneB);
    await openToolbar(phoneB.page);
    await phoneB.page.click('[data-testid=tool-disconnect]');
    await phoneB.page.click('[data-testid=dialog-ok]');
    await phoneB.page.click('text=Voltar');
  });

  // ==== C: dispositivo confiável (acesso não assistido por chave) =========================
  await step('C1 celular confiável reconecta sozinho (assinatura Ed25519, sem senha nem aprovação)', async () => {
    await hostPage.waitForSelector('[data-testid=session-card]', { state: 'detached', timeout: 8000 });
    await connectPhone(phoneA, hostId);
    await waitConnected(phoneA);
    await openToolbar(phoneA.page);
    await phoneA.page.click('[data-testid=tool-settings]');
    const txt = await phoneA.page.textContent('.info-grid');
    assert(/Dispositivo confiável/.test(txt), 'método = dispositivo confiável');
    await closeSheet(phoneA.page);
    await openToolbar(phoneA.page);
    await phoneA.page.click('[data-testid=tool-disconnect]');
    await phoneA.page.click('[data-testid=dialog-ok]');
    await phoneA.page.click('text=Voltar');
  });

  // ==== D: recusa ==========================================================================
  await step('D1 pedido recusado no computador é informado ao celular', async () => {
    await hostPage.waitForSelector('[data-testid=session-card]', { state: 'detached', timeout: 8000 });
    const phoneD = await newPhone(browser, 'celularD');
    await connectPhone(phoneD, hostId);
    await phoneD.page.waitForSelector('[data-testid=auth-approval]', { timeout: 20000 });
    const winP = host.waitForEvent('window', { predicate: (w) => w.url().includes('view=approval'), timeout: 15000 });
    await phoneD.page.click('[data-testid=auth-approval]');
    const approval = await winP;
    await approval.waitForSelector('[data-testid=approve-reject]');
    await clickClosing(approval, '[data-testid=approve-reject]');
    await phoneD.page.waitForSelector('[data-testid=end-reason]:has-text("recusado")', { timeout: 10000 });
  });

  await step('D2 desativar conexões remotas bloqueia novos pedidos', async () => {
    await setSwitch(hostPage, 'toggle-incoming', false);
    const phoneE = await newPhone(browser, 'celularE');
    await connectPhone(phoneE, hostId);
    await phoneE.page.waitForSelector('[data-testid=end-reason]:has-text("desativadas")', { timeout: 10000 });
    await setSwitch(hostPage, 'toggle-incoming', true);
  });

  await hostPage.screenshot({ path: path.join(ART, 'host-dashboard.png') });
}

main()
  .catch((err) => {
    if (!failed) {
      failed++;
      results.push({ name: 'execução', ok: false, error: String(err?.stack || err) });
    }
    console.error(err);
  })
  .finally(async () => {
    const report = { date: new Date().toISOString(), passed: results.filter((r) => r.ok).length, failed, results, metrics };
    fs.writeFileSync(path.join(ART, 'report.json'), JSON.stringify(report, null, 2));
    if (target) fs.writeFileSync(path.join(ART, 'target-events.json'), JSON.stringify(target.events, null, 1));
    log(`RESULTADO: ${report.passed} etapas OK, ${failed} falha(s). Relatório: tests/e2e/.artifacts/report.json`);
    log('métricas:', JSON.stringify(metrics));
    try {
      await browser?.close();
    } catch {}
    try {
      await host?.close();
    } catch {}
    for (const p of procs) p.kill('SIGTERM');
    setTimeout(() => process.exit(failed ? 1 : 0), 500);
  });
