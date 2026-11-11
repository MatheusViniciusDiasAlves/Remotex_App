#!/usr/bin/env node
/**
 * Build do RemoteX com esbuild.
 *   node scripts/build.mjs            → servidor + cliente web
 *   node scripts/build.mjs server     → apenas servidor (dist/server)
 *   node scripts/build.mjs client     → apenas cliente web (android-app/web/dist)
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const want = (t) => targets.length === 0 || targets.includes(t);
const prod = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');

async function buildServer() {
  const common = {
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    packages: 'external',
    sourcemap: true,
    tsconfig: path.join(root, 'tsconfig.json'),
    logLevel: 'warning',
  };
  await build({ ...common, entryPoints: [path.join(root, 'backend/src/server.ts')], outfile: path.join(root, 'dist/server/server.js') });
  await build({ ...common, entryPoints: [path.join(root, 'backend/src/migrate-cli.ts')], outfile: path.join(root, 'dist/server/migrate.js') });
  console.log('✓ servidor → dist/server');
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function buildClient() {
  const web = path.join(root, 'android-app/web');
  const out = path.join(web, 'dist');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  await build({
    entryPoints: [path.join(web, 'src/main.ts')],
    outfile: path.join(out, 'app.js'),
    bundle: true,
    platform: 'browser',
    target: ['chrome90', 'safari15'],
    format: 'iife',
    minify: prod,
    sourcemap: !prod,
    tsconfig: path.join(root, 'tsconfig.json'),
    logLevel: 'warning',
  });
  copyDir(path.join(web, 'public'), out);
  console.log('✓ cliente web → android-app/web/dist');
}

if (want('server')) await buildServer();
if (want('client')) await buildClient();
