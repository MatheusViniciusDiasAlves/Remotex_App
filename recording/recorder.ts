/**
 * Gravação de sessão com MediaRecorder (usado no HOST — salva no computador — e no celular —
 * salva no aparelho). Suporta pausar/retomar e escolha de qualidade. Sempre acompanhado de
 * indicador visível de gravação nas duas pontas (ver host e cliente).
 */
import type { RecordingQuality } from '@remotex/media/channel-protocol';

export const RECORDING_BITRATES: Record<RecordingQuality, { video: number; audio: number; label: string }> = {
  low: { video: 1_000_000, audio: 64_000, label: 'Baixa (1 Mbps)' },
  medium: { video: 3_000_000, audio: 128_000, label: 'Média (3 Mbps)' },
  high: { video: 8_000_000, audio: 160_000, label: 'Alta (8 Mbps)' },
};

const CANDIDATE_TYPES = [
  'video/mp4;codecs=avc1.42E01F,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickRecordingMime(isSupported: (t: string) => boolean = (t) => MediaRecorder.isTypeSupported(t)): string {
  for (const t of CANDIDATE_TYPES) {
    try {
      if (isSupported(t)) return t;
    } catch {
      /* ignora */
    }
  }
  return '';
}

export function recordingExtension(mime: string): string {
  return mime.startsWith('video/mp4') ? 'mp4' : 'webm';
}

export function recordingFileName(prefix: string, mime: string, date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `${prefix}-${stamp}.${recordingExtension(mime)}`;
}

export type RecorderState = 'inactive' | 'recording' | 'paused';

export interface RecorderOptions {
  quality: RecordingQuality;
  timesliceMs?: number;
  onChunk: (chunk: Blob) => void | Promise<void>;
  onError?: (err: unknown) => void;
}

export class SessionRecorder {
  private rec: MediaRecorder | null = null;
  private startedAt = 0;
  private pausedTotal = 0;
  private pausedAt = 0;
  private bytes = 0;
  private pending: Promise<void> = Promise.resolve();
  mimeType = '';

  get state(): RecorderState {
    return (this.rec?.state as RecorderState) || 'inactive';
  }

  get size(): number {
    return this.bytes;
  }

  get durationMs(): number {
    if (!this.startedAt) return 0;
    const now = this.pausedAt || Date.now();
    return now - this.startedAt - this.pausedTotal;
  }

  start(stream: MediaStream, opts: RecorderOptions): void {
    if (this.rec) throw new Error('Gravação já iniciada');
    this.mimeType = pickRecordingMime();
    const br = RECORDING_BITRATES[opts.quality];
    const hasAudio = stream.getAudioTracks().length > 0;
    this.rec = new MediaRecorder(stream, {
      mimeType: this.mimeType || undefined,
      videoBitsPerSecond: br.video,
      audioBitsPerSecond: hasAudio ? br.audio : undefined,
    });
    if (!this.mimeType) this.mimeType = this.rec.mimeType || 'video/webm';
    this.bytes = 0;
    this.pausedTotal = 0;
    this.pausedAt = 0;
    this.rec.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      this.bytes += e.data.size;
      this.pending = this.pending.then(() => opts.onChunk(e.data)).catch((err) => opts.onError?.(err));
    };
    this.rec.onerror = (e) => opts.onError?.(e);
    this.rec.start(opts.timesliceMs ?? 1000);
    this.startedAt = Date.now();
  }

  pause(): void {
    if (this.rec?.state === 'recording') {
      this.rec.pause();
      this.pausedAt = Date.now();
    }
  }

  resume(): void {
    if (this.rec?.state === 'paused') {
      this.rec.resume();
      this.pausedTotal += Date.now() - this.pausedAt;
      this.pausedAt = 0;
    }
  }

  async stop(): Promise<{ mimeType: string; size: number; durationMs: number }> {
    const rec = this.rec;
    if (!rec) return { mimeType: this.mimeType, size: 0, durationMs: 0 };
    const duration = this.durationMs;
    await new Promise<void>((resolve) => {
      rec.addEventListener('stop', () => resolve(), { once: true });
      if (rec.state !== 'inactive') rec.stop();
      else resolve();
    });
    await this.pending;
    this.rec = null;
    this.startedAt = 0;
    return { mimeType: this.mimeType, size: this.bytes, durationMs: duration };
  }
}
