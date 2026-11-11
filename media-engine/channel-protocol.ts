/**
 * Protocolo dos canais de dados WebRTC (fim a fim, criptografado por DTLS).
 *
 * Canais:
 *  - "control" (confiável, ordenado): teclado, cliques, roda do mouse, área de transferência,
 *    qualidade, áudio, gravação, administração (RPC).
 *  - "motion" (ordenado, sem retransmissão): movimentos do ponteiro e posição do cursor —
 *    pacotes atrasados são descartados para não acumular latência.
 *
 * Coordenadas são normalizadas (0..1) em relação à tela capturada: independem da escala
 * aplicada ao vídeo e da resolução do celular. Eventos de botão carregam a posição para
 * nunca clicarem no lugar errado caso um movimento sem retransmissão se perca.
 */
import type { PermissionSet } from '@remotex/security/permissions';

export const CONTROL_CHANNEL = 'control';
export const MOTION_CHANNEL = 'motion';

export type MouseButton = 0 | 1 | 2; // esquerdo, meio, direito

export type QualityPreset = 'auto' | 'high' | 'balanced' | 'economy';
export type AudioQuality = 'low' | 'medium' | 'high';
export type RecordingQuality = 'low' | 'medium' | 'high';

export interface DisplayInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  primary: boolean;
}

export type MotionMessage =
  | { k: 'mv'; x: number; y: number; s: number }
  | { k: 'cur'; x: number; y: number };

export type ClientControlMessage =
  | { k: 'hello'; viewport: { w: number; h: number; dpr: number }; app: string }
  | { k: 'bind'; proof: string }
  | { k: 'key'; code: string; down: boolean }
  | { k: 'combo'; codes: string[] }
  | { k: 'text'; text: string }
  | { k: 'btn'; b: MouseButton; down: boolean; x: number; y: number; s: number }
  | { k: 'click'; b: MouseButton; x: number; y: number; n: 1 | 2; s: number }
  | { k: 'wheel'; dx: number; dy: number; x: number; y: number }
  | { k: 'release' }
  | { k: 'quality'; preset: QualityPreset; original?: boolean }
  | { k: 'audio'; enabled: boolean; quality?: AudioQuality }
  | { k: 'mic'; enabled: boolean }
  | { k: 'clip'; text: string }
  | { k: 'clip.get' }
  | { k: 'rec'; action: 'start' | 'pause' | 'resume' | 'stop'; target: 'host' | 'client'; quality?: RecordingQuality; audio?: boolean }
  | { k: 'display'; id: string }
  | { k: 'cstats'; fps: number; rtt: number; loss: number; jitter: number; decodeMs: number; w: number; h: number }
  | { k: 'rpc'; id: number; method: string; params?: Record<string, unknown> }
  | { k: 'special'; action: 'ctrl-alt-del' | 'lock' | 'task-manager' }
  | { k: 'bye'; reason?: string };

export type RecordingState = 'pending' | 'recording' | 'paused' | 'stopped' | 'denied' | 'error';

export type HostControlMessage =
  | {
      k: 'welcome';
      hostName: string;
      os: string;
      permissions: PermissionSet;
      displays: DisplayInfo[];
      activeDisplay: string;
      sas: string | null;
      quality: QualityPreset;
      audioAvailable: boolean;
      elevated: boolean;
    }
  | { k: 'bind.result'; ok: boolean }
  | { k: 'perms'; permissions: PermissionSet }
  | { k: 'clip'; text: string }
  | { k: 'ime'; editable: boolean }
  | { k: 'rec.state'; target: 'host' | 'client'; state: RecordingState; file?: string; message?: string }
  | { k: 'notice'; level: 'info' | 'warn' | 'error'; message: string; code?: string }
  | { k: 'quality.state'; preset: QualityPreset; effective: Exclude<QualityPreset, 'auto'>; bitrateKbps: number; fps: number; scale: number }
  | { k: 'display'; activeDisplay: string; displays: DisplayInfo[] }
  | { k: 'audio.state'; enabled: boolean; available: boolean }
  | { k: 'rpc.res'; id: number; ok: boolean; result?: unknown; error?: string }
  | { k: 'bye'; reason?: string };

/** Mensagens repassadas da janela de mídia (renderer) para o processo principal do host. */
export type InputEvent =
  | Extract<ClientControlMessage, { k: 'key' | 'combo' | 'text' | 'btn' | 'click' | 'wheel' | 'release' }>
  | Extract<MotionMessage, { k: 'mv' }>;

export function isInputEvent(m: { k: string }): m is InputEvent {
  return ['key', 'combo', 'text', 'btn', 'click', 'wheel', 'release', 'mv'].includes(m.k);
}

export const MAX_CHANNEL_MESSAGE = 256 * 1024;
export const MAX_CLIPBOARD_TEXT = 1024 * 1024 / 2;
export const MAX_TEXT_INPUT = 4096;
