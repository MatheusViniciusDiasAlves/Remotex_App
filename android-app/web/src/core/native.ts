/**
 * Ponte com o aplicativo Android nativo (Kotlin). Quando o app roda no navegador (sem o shell),
 * cada função usa a melhor alternativa da Web disponível.
 */
interface NativeBridge {
  deviceModel(): string;
  appVersion(): string;
  showKeyboard(): void;
  hideKeyboard(): void;
  setImmersive(on: boolean): void;
  setOrientation(mode: string): void;
  keepScreenOn(on: boolean): void;
  vibrate(ms: number): void;
  getClipboard(): string;
  setClipboard(text: string): void;
  recBegin(name: string, mime: string): string;
  recChunk(id: string, base64: string): boolean;
  recEnd(id: string): string;
  listRecordings(): string;
  openRecording(name: string): void;
  requestMicPermission(): void;
  hasMicPermission(): boolean;
}

const bridge: NativeBridge | null = (window as any).RemoteXNative ?? null;

export const isNativeApp = Boolean(bridge);

let wakeLock: any = null;

export const native = {
  showKeyboard(): void {
    bridge?.showKeyboard();
  },
  hideKeyboard(): void {
    bridge?.hideKeyboard();
  },
  async setImmersive(on: boolean): Promise<void> {
    if (bridge) return bridge.setImmersive(on);
    try {
      if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      if (!on && document.fullscreenElement) await document.exitFullscreen();
    } catch {
      /* tela cheia indisponível */
    }
  },
  async setOrientation(mode: 'auto' | 'landscape' | 'portrait'): Promise<void> {
    if (bridge) return bridge.setOrientation(mode);
    try {
      const o = (screen as any).orientation;
      if (mode === 'auto') o?.unlock?.();
      else await o?.lock?.(mode);
    } catch {
      /* exige tela cheia em navegadores */
    }
  },
  async keepScreenOn(on: boolean): Promise<void> {
    if (bridge) return bridge.keepScreenOn(on);
    try {
      if (on && !wakeLock) wakeLock = await (navigator as any).wakeLock?.request('screen');
      if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch {
      /* Wake Lock indisponível */
    }
  },
  vibrate(ms = 15): void {
    if (bridge) return bridge.vibrate(ms);
    try {
      navigator.vibrate?.(ms);
    } catch {
      /* sem vibração */
    }
  },
  async getClipboard(): Promise<string> {
    if (bridge) return bridge.getClipboard();
    try {
      return await navigator.clipboard.readText();
    } catch {
      return '';
    }
  },
  async setClipboard(text: string): Promise<boolean> {
    if (bridge) {
      bridge.setClipboard(text);
      return true;
    }
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  },
  /** Gravação no celular: arquivos são gravados aos pedaços pelo app nativo (sem estourar memória). */
  recordingSink(name: string, mime: string) {
    if (bridge) {
      const id = bridge.recBegin(name, mime);
      return {
        async write(chunk: Blob) {
          const buf = new Uint8Array(await chunk.arrayBuffer());
          let bin = '';
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          bridge!.recChunk(id, btoa(bin));
        },
        async close(): Promise<string> {
          return bridge!.recEnd(id) || 'Movies/RemoteX';
        },
      };
    }
    const parts: Blob[] = [];
    return {
      async write(chunk: Blob) {
        parts.push(chunk);
      },
      async close(): Promise<string> {
        const blob = new Blob(parts, { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        return 'Downloads';
      },
    };
  },
  listNativeRecordings(): Array<{ name: string; size: number; createdAt: string }> | null {
    if (!bridge) return null;
    try {
      return JSON.parse(bridge.listRecordings());
    } catch {
      return [];
    }
  },
  openRecording(name: string): void {
    bridge?.openRecording(name);
  },
};
