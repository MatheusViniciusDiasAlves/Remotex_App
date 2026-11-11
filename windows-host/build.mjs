#!/usr/bin/env node
/** Build do RemoteX Host (Electron) com esbuild → windows-host/dist */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = path.join(here, 'dist');
const prod = process.env.NODE_ENV === 'production';
const tsconfig = path.join(root, 'tsconfig.json');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'renderer'), { recursive: true });

const node = { bundle: true, platform: 'node', target: 'node20', format: 'cjs', sourcemap: !prod, minify: prod, tsconfig, logLevel: 'warning', external: ['electron', 'koffi'], nodePaths: [path.join(here, 'node_modules')] };
const browser = { bundle: true, platform: 'browser', target: 'chrome120', format: 'iife', sourcemap: !prod, minify: prod, tsconfig, logLevel: 'warning' };

await Promise.all([
  build({ ...node, entryPoints: [path.join(here, 'src/main/main.ts')], outfile: path.join(out, 'main.js') }),
  build({ ...node, entryPoints: [path.join(here, 'src/preload/ui-preload.ts')], outfile: path.join(out, 'preload/ui-preload.js') }),
  build({ ...node, entryPoints: [path.join(here, 'src/preload/engine-preload.ts')], outfile: path.join(out, 'preload/engine-preload.js') }),
  build({ ...browser, entryPoints: [path.join(here, 'src/renderer/ui/ui.ts')], outfile: path.join(out, 'renderer/ui.js') }),
  build({ ...browser, entryPoints: [path.join(here, 'src/renderer/engine/engine.ts')], outfile: path.join(out, 'renderer/engine.js') }),
]);

for (const f of ['ui/ui.html', 'ui/ui.css', 'engine/engine.html']) {
  fs.copyFileSync(path.join(here, 'src/renderer', f), path.join(out, 'renderer', path.basename(f)));
}
console.log('✓ host → windows-host/dist');
