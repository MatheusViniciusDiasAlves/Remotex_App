/** Contrato IPC entre o processo principal do host e a janela de mídia (WebRTC). */
import type { IceServer, RelayPayload } from '@remotex/signaling/protocol';
import type { AudioQuality, QualityPreset, RecordingQuality } from '@remotex/media/channel-protocol';
import type { VideoCodecPref } from '@remotex/media/codecs';
import type { OutboundSummary } from '@remotex/media/stats';

export type EngineCommand =
  | {
      type: 'start';
      sessionId: string;
      iceServers: IceServer[];
      captureAudio: boolean;
      quality: QualityPreset;
      codec: VideoCodecPref;
      audioQuality: AudioQuality;
    }
  | { type: 'signal'; sessionId: string; payload: RelayPayload }
  | { type: 'send'; sessionId: string; channel: 'control' | 'motion'; msg: unknown }
  | { type: 'quality'; sessionId: string; preset: QualityPreset; original: boolean }
  | { type: 'audio'; sessionId: string; enabled: boolean; quality?: AudioQuality }
  | { type: 'mic'; sessionId: string; allowed: boolean }
  | { type: 'display'; sessionId: string }
  | { type: 'rec-start'; sessionId: string; quality: RecordingQuality; includeAudio: boolean }
  | { type: 'rec-pause'; sessionId: string }
  | { type: 'rec-resume'; sessionId: string }
  | { type: 'rec-stop'; sessionId: string }
  | { type: 'stop'; sessionId: string };

export type EngineEvent =
  | { type: 'ready' }
  | { type: 'signal'; sessionId: string; payload: RelayPayload }
  | { type: 'channel-open'; sessionId: string }
  | { type: 'control'; sessionId: string; msg: any }
  | { type: 'motion'; sessionId: string; msg: any }
  | { type: 'state'; sessionId: string; state: RTCPeerConnectionState }
  | { type: 'capture'; sessionId: string; width: number; height: number; audio: boolean; label: string }
  | { type: 'stats'; sessionId: string; stats: OutboundSummary; preset: QualityPreset; effective: string }
  | { type: 'rec-state'; sessionId: string; state: 'recording' | 'paused' | 'stopped' | 'error'; mime?: string; message?: string }
  | { type: 'error'; sessionId: string; message: string };

export interface EngineBridge {
  onCommand(cb: (cmd: EngineCommand) => void): void;
  emit(ev: EngineEvent): void;
  recChunk(sessionId: string, data: ArrayBuffer): Promise<void>;
}
