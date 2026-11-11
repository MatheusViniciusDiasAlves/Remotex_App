/** Contrato IPC entre o painel do host (UI) e o processo principal. */
import type { PermissionSet } from '@remotex/security/permissions';
import type { AudioQuality, QualityPreset, RecordingQuality, RecordingState } from '@remotex/media/channel-protocol';
import type { VideoCodecPref } from '@remotex/media/codecs';
import type { HistoryEntry, TrustedDevice } from '../main/config-store';

export interface ActiveSessionView {
  sessionId: string;
  clientId: string;
  clientName: string;
  clientFingerprint: string;
  ip: string | null;
  method: string;
  permissions: PermissionSet;
  startedAt: number;
  connected: boolean;
  verified: boolean;
  sas: string | null;
  recording: { target: 'host' | 'client'; state: RecordingState } | null;
  stats: { kbps: number; fps: number; rttMs: number | null; path: string; codec: string; encoder: string; width: number; height: number } | null;
  quality: string;
}

export interface ApprovalRequestView {
  sessionId: string;
  clientId: string;
  clientName: string;
  fingerprint: string;
  ip: string | null;
  account: string | null;
  platform: string;
  expiresAt: number;
  suggested: PermissionSet;
  policy: PermissionSet;
}

export interface HostStateView {
  deviceId: string | null;
  deviceName: string;
  serverUrl: string;
  status: 'offline' | 'connecting' | 'online' | 'unauthorized' | 'registering' | 'error';
  statusMessage: string;
  hostFingerprint: string;
  incomingEnabled: boolean;
  attendedEnabled: boolean;
  unattendedEnabled: boolean;
  hasPassword: boolean;
  passwordLockedForMs: number;
  policy: PermissionSet;
  passwordPermissions: PermissionSet;
  trusted: Array<Omit<TrustedDevice, 'publicKey'>>;
  history: HistoryEntry[];
  quality: { preset: QualityPreset; codec: VideoCodecPref };
  audio: { quality: AudioQuality; enabledByDefault: boolean };
  recording: { dir: string; quality: RecordingQuality };
  launchAtStartup: boolean;
  runInBackground: boolean;
  approvalTimeoutSec: number;
  elevated: boolean;
  platform: string;
  version: string;
  session: ActiveSessionView | null;
  approvals: ApprovalRequestView[];
}

export interface RecordingFile {
  name: string;
  path: string;
  size: number;
  createdAt: string;
}

export interface HostApi {
  getState(): Promise<HostStateView>;
  onState(cb: (s: HostStateView) => void): void;
  setIncoming(v: boolean): Promise<void>;
  setAttended(v: boolean): Promise<void>;
  setUnattended(v: boolean): Promise<void>;
  setPassword(pw: string | null): Promise<string | null>;
  setPolicy(p: PermissionSet): Promise<void>;
  setPasswordPermissions(p: PermissionSet): Promise<void>;
  updateTrusted(publicKeyFp: string, patch: { permissions?: PermissionSet; unattended?: boolean; name?: string }): Promise<void>;
  revokeTrusted(fp: string): Promise<void>;
  setDeviceName(name: string): Promise<void>;
  setServerUrl(url: string): Promise<string | null>;
  reregister(): Promise<string | null>;
  setQuality(q: { preset: QualityPreset; codec: VideoCodecPref }): Promise<void>;
  setAudio(a: { quality: AudioQuality; enabledByDefault: boolean }): Promise<void>;
  setRecording(r: { quality: RecordingQuality }): Promise<void>;
  chooseRecordingDir(): Promise<void>;
  setLaunchAtStartup(v: boolean): Promise<void>;
  setRunInBackground(v: boolean): Promise<void>;
  setApprovalTimeout(sec: number): Promise<void>;
  endSession(): Promise<void>;
  stopRecording(): Promise<void>;
  listRecordings(): Promise<RecordingFile[]>;
  openRecording(name: string): Promise<void>;
  showRecordingsFolder(): Promise<void>;
  deleteRecording(name: string): Promise<void>;
  relaunchElevated(): Promise<{ ok: boolean; message: string }>;
  copyId(): Promise<void>;
  clearHistory(): Promise<void>;
  decide(sessionId: string, d: { accept: boolean; permissions: PermissionSet; trust: boolean; unattended: boolean }): Promise<void>;
  showMain(): Promise<void>;
}
