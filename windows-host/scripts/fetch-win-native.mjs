#!/usr/bin/env node
/**
 * Garante o binário nativo do koffi para Windows x64 em node_modules/@koromix/koffi-win32-x64.
 * No Windows o npm já o instala; em Linux/macOS (geração cruzada do instalador) é baixado do npm.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ver = JSON.parse(fs.readFileSync(path.join(here, 'node_modules/koffi/package.json'), 'utf8')).version;
const dest = path.join(here, 'node_modules/@koromix/koffi-win32-x64');
const pkg = path.join(dest, 'package.json');
if (fs.existsSync(pkg) && JSON.parse(fs.readFileSync(pkg, 'utf8')).version === ver) process.exit(0);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koffi-'));
execSync(`npm pack @koromix/koffi-win32-x64@${ver} --silent`, { cwd: tmp, stdio: ['ignore', 'pipe', 'inherit'] });
const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
fs.mkdirSync(dest, { recursive: true });
execSync(`tar -xzf "${path.join(tmp, tgz)}" -C "${dest}" --strip-components=1`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`✓ koffi win32-x64 ${ver}`);
