/** Configuração do áudio da sessão (som do PC → celular e microfone do celular → PC). */
import type { AudioQuality } from '@remotex/media/channel-protocol';

export interface AudioSpec {
  maxBitrate: number;
  stereo: boolean;
  label: string;
}

export const AUDIO_PRESETS: Record<AudioQuality, AudioSpec> = {
  low: { maxBitrate: 32_000, stereo: false, label: 'Baixa (32 kbps, mono)' },
  medium: { maxBitrate: 64_000, stereo: true, label: 'Média (64 kbps, estéreo)' },
  high: { maxBitrate: 128_000, stereo: true, label: 'Alta (128 kbps, estéreo)' },
};

/** Restrições do microfone do celular: cancelamento de eco e supressão de ruído ligados. */
export const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};
