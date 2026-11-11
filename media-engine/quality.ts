/**
 * Qualidade de vídeo: presets e controlador adaptativo.
 *
 * O WebRTC (GCC) já ajusta a taxa de bits dentro do teto definido; o controlador abaixo escolhe
 * o teto/FPS/resolução (preset) conforme a rede medida: perda de pacotes, RTT e banda
 * disponível. Rebaixa rápido (2 amostras ruins) e promove devagar (5 amostras boas) para evitar
 * oscilação.
 */
import type { QualityPreset } from './channel-protocol';

export type ConcretePreset = Exclude<QualityPreset, 'auto'>;

export interface PresetSpec {
  maxBitrateKbps: number;
  maxFps: number;
  /** maior lado máximo do vídeo (px) quando não está em "resolução original" */
  maxLongEdge: number;
  degradation: RTCDegradationPreference;
  /** banda mínima sustentada para manter este preset no modo automático */
  minKbps: number;
  label: string;
}

export const PRESETS: Record<ConcretePreset, PresetSpec> = {
  high: { maxBitrateKbps: 12000, maxFps: 60, maxLongEdge: 3840, degradation: 'maintain-resolution', minKbps: 5000, label: 'Alta qualidade' },
  balanced: { maxBitrateKbps: 5000, maxFps: 30, maxLongEdge: 1920, degradation: 'balanced', minKbps: 1500, label: 'Equilibrado' },
  economy: { maxBitrateKbps: 1000, maxFps: 15, maxLongEdge: 1280, degradation: 'maintain-resolution', minKbps: 0, label: 'Econômico' },
};

export const PRESET_ORDER: ConcretePreset[] = ['economy', 'balanced', 'high'];

export interface EncodingParams {
  maxBitrate: number; // bps
  maxFramerate: number;
  scaleResolutionDownBy: number;
  degradationPreference: RTCDegradationPreference;
}

export function encodingFor(
  preset: ConcretePreset,
  source: { width: number; height: number },
  opts: { original?: boolean } = {},
): EncodingParams {
  const spec = PRESETS[preset];
  const longEdge = Math.max(source.width, source.height, 1);
  let scale = 1;
  if (!opts.original && longEdge > spec.maxLongEdge) scale = longEdge / spec.maxLongEdge;
  scale = Math.round(scale * 100) / 100;
  return {
    maxBitrate: spec.maxBitrateKbps * 1000,
    maxFramerate: spec.maxFps,
    scaleResolutionDownBy: Math.max(1, scale),
    degradationPreference: opts.original ? 'maintain-resolution' : spec.degradation,
  };
}

export interface NetworkSample {
  availableKbps: number | null;
  rttMs: number | null;
  lossPct: number | null;
  limitation?: string | null;
}

export class AdaptiveQualityController {
  private bad = 0;
  private good = 0;
  current: ConcretePreset;

  constructor(initial: ConcretePreset = 'balanced', private readonly ceiling: ConcretePreset = 'high') {
    this.current = initial;
  }

  /** Avalia uma amostra; retorna o novo preset quando houver mudança. */
  evaluate(s: NetworkSample): ConcretePreset | null {
    const idx = PRESET_ORDER.indexOf(this.current);
    const spec = PRESETS[this.current];
    const isBad =
      (s.lossPct != null && s.lossPct > 5) ||
      (s.rttMs != null && s.rttMs > 450) ||
      (s.availableKbps != null && s.availableKbps < spec.minKbps * 0.8);
    const next = PRESET_ORDER[idx + 1];
    const canUp = next && PRESET_ORDER.indexOf(next) <= PRESET_ORDER.indexOf(this.ceiling);
    const isGood =
      canUp &&
      (s.lossPct == null || s.lossPct < 1) &&
      (s.rttMs == null || s.rttMs < 180) &&
      s.availableKbps != null &&
      s.availableKbps > PRESETS[next].minKbps * 1.3;

    if (isBad) {
      this.good = 0;
      this.bad++;
      if (this.bad >= 2 && idx > 0) {
        this.bad = 0;
        this.current = PRESET_ORDER[idx - 1];
        return this.current;
      }
      return null;
    }
    this.bad = 0;
    if (isGood) {
      this.good++;
      if (this.good >= 5) {
        this.good = 0;
        this.current = next;
        return this.current;
      }
    } else {
      this.good = 0;
    }
    return null;
  }
}
