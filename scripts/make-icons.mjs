#!/usr/bin/env node
/**
 * Gera os ícones do RemoteX a partir de android-app/web/public/icon.svg:
 *  - PWA: icon-192.png, icon-512.png
 *  - Host Windows: windows-host/assets/icon.png, icon.ico (PNG embutido), tray.png
 *  - Android: android-app/app/src/main/res/mipmap-*\/ic_launcher.png
 * Usa o Chromium do Playwright para rasterizar o SVG.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require('/opt/node-tools/node_modules/playwright');
}

const svg = fs.readFileSync(path.join(root, 'android-app/web/public/icon.svg'), 'utf8');
const browser = await playwright.chromium.launch();
const page = await browser.newPage();

async function render(size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

const write = (rel, data) => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
  console.log('✓', rel);
};

write('android-app/web/public/icon-192.png', await render(192));
write('android-app/web/public/icon-512.png', await render(512));
write('windows-host/assets/icon.png', await render(512));
write('windows-host/assets/tray.png', await render(32));
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoPngs = [];
for (const s of icoSizes) icoPngs.push({ size: s, data: await render(s) });
write('windows-host/assets/icon.ico', ico(icoPngs));
const mipmaps = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, s] of Object.entries(mipmaps)) write(`android-app/app/src/main/res/mipmap-${d}/ic_launcher.png`, await render(s));
await browser.close();
