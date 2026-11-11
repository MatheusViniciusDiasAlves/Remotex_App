/** Arquivos de gravação de sessão salvos no computador. */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { RecordingFile } from '../shared/ui-ipc';

export class RecordingStore {
  private stream: fs.WriteStream | null = null;
  private buffered: Buffer[] = [];
  currentFile: string | null = null;

  constructor(private readonly dirOverride: () => string | null) {}

  get dir(): string {
    const d = this.dirOverride() || path.join(app.getPath('videos'), 'RemoteX');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  begin(fileName: string): string {
    const full = path.join(this.dir, path.basename(fileName));
    this.stream = fs.createWriteStream(full, { flags: 'wx' });
    this.currentFile = full;
    for (const b of this.buffered.splice(0)) this.stream.write(b);
    return full;
  }

  /** Grava um pedaço; se o arquivo ainda não foi criado, guarda em memória até begin(). */
  write(data: ArrayBuffer): Promise<void> {
    const buf = Buffer.from(data);
    const s = this.stream;
    if (!s) {
      this.buffered.push(buf);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => s.write(buf, (err) => (err ? reject(err) : resolve())));
  }

  finish(): Promise<string | null> {
    const s = this.stream;
    const file = this.currentFile;
    this.stream = null;
    this.currentFile = null;
    this.buffered = [];
    if (!s) return Promise.resolve(null);
    return new Promise((resolve) => s.end(() => resolve(file)));
  }

  list(): RecordingFile[] {
    const dir = this.dir;
    return fs
      .readdirSync(dir)
      .filter((f) => /\.(webm|mp4)$/i.test(f))
      .map((name) => {
        const st = fs.statSync(path.join(dir, name));
        return { name, path: path.join(dir, name), size: st.size, createdAt: st.mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  resolve(name: string): string | null {
    const full = path.join(this.dir, path.basename(name));
    return fs.existsSync(full) ? full : null;
  }
}
