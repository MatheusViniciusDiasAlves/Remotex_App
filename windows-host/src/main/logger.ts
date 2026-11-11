/**
 * Log em arquivo do RemoteX Host (%APPDATA%/RemoteX Host/logs/remotex-host.log).
 * No Windows, aplicativos de interface gráfica não têm console: sem este arquivo seria
 * impossível diagnosticar problemas em campo. Rotação simples a cada 5 MB (mantém 1 anterior).
 * Nunca registra senhas, tokens ou chaves.
 */
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

const MAX = 5 * 1024 * 1024;

export function installFileLogger(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'remotex-host.log');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX) fs.renameSync(file, file + '.1');
  } catch {
    /* ignora */
  }
  const write = (level: string, args: unknown[]) => {
    const line = `${new Date().toISOString()} [${level}] ${util.format(...args)}\n`;
    try {
      fs.appendFileSync(file, line);
    } catch {
      /* disco cheio ou sem permissão: não derruba o app */
    }
  };
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      write(level.toUpperCase(), args);
      original(...args);
    };
  }
  process.on('uncaughtException', (err) => write('FATAL', [err?.stack || err]));
  process.on('unhandledRejection', (err) => write('FATAL', ['Promise rejeitada:', (err as Error)?.stack || err]));
  return file;
}
