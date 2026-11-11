/**
 * Janela de mídia do HOST (oculta): captura a tela, transmite via WebRTC para o celular, recebe
 * os eventos de controle pelos canais de dados e os entrega ao processo principal (que valida
 * permissões e injeta no Windows). Também ajusta qualidade/bitrate e grava a sessão.
 */
import type { EngineBridge, EngineCommand } from '../../shared/engine-ipc';
import { CONTROL_CHANNEL, MOTION_CHANNEL, MAX_CHANNEL_MESSAGE, type QualityPreset } from '@remotex/media/channel-protocol';
import { AdaptiveQualityController, encodingFor, type ConcretePreset } from '@remotex/media/quality';
import { sortCodecs, tuneOpus } from '@remotex/media/codecs';
import { OutboundStatsTracker } from '@remotex/media/stats';
import { AUDIO_PRESETS } from '@remotex/audio/audio-config';
import { SessionRecorder } from '@remotex/recording/recorder';

declare global {
  interface Window {
    engineBridge: EngineBridge;
  }
}

const bridge = window.engineBridge;

interface Session {
  id: string;
  pc: RTCPeerConnection;
  stream: MediaStream | null;
  videoSender: RTCRtpSender | null;
  audioSender: RTCRtpSender | null;
  audioTrack: MediaStreamTrack | null;
  audioEnabled: boolean;
  audioQuality: keyof typeof AUDIO_PRESETS;
  control: RTCDataChannel | null;
  motion: RTCDataChannel | null;
  preset: QualityPreset;
  original: boolean;
  adaptive: AdaptiveQualityController;
  effective: ConcretePreset;
  stats: OutboundStatsTracker;
  statsTimer: number | null;
  pendingIce: RTCIceCandidateInit[];
  remoteSet: boolean;
  micEl: HTMLAudioElement;
  micAllowed: boolean;
  remoteMic: MediaStream | null;
  recorder: SessionRecorder | null;
  audioCtx: AudioContext | null;
}

const sessions = new Map<string, Session>();

function emitError(sessionId: string, err: unknown) {
  bridge.emit({ type: 'error', sessionId, message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
}

async function capture(withAudio: boolean): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 60, max: 60 } } as MediaTrackConstraints,
    audio: withAudio,
  });
}

function sourceSize(s: Session): { width: number; height: number } {
  const st = s.stream?.getVideoTracks()[0]?.getSettings();
  return { width: st?.width || 1920, height: st?.height || 1080 };
}

async function applyQuality(s: Session): Promise<void> {
  if (!s.videoSender) return;
  const effective: ConcretePreset = s.preset === 'auto' ? s.adaptive.current : s.preset;
  s.effective = effective;
  const enc = encodingFor(effective, sourceSize(s), { original: s.original });
  const params = s.videoSender.getParameters();
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
  params.encodings[0].maxBitrate = enc.maxBitrate;
  params.encodings[0].maxFramerate = enc.maxFramerate;
  params.encodings[0].scaleResolutionDownBy = enc.scaleResolutionDownBy;
  (params as any).degradationPreference = enc.degradationPreference;
  try {
    await s.videoSender.setParameters(params);
  } catch (err) {
    emitError(s.id, err);
  }
  const track = s.videoSender.track;
  if (track) track.contentHint = 'detail';
  sendControl(s, {
    k: 'quality.state',
    preset: s.preset,
    effective,
    bitrateKbps: Math.round(enc.maxBitrate / 1000),
    fps: enc.maxFramerate,
    scale: enc.scaleResolutionDownBy,
  });
}

async function applyAudioParams(s: Session): Promise<void> {
  if (!s.audioSender) return;
  const spec = AUDIO_PRESETS[s.audioQuality];
  const p = s.audioSender.getParameters();
  if (!p.encodings || p.encodings.length === 0) p.encodings = [{}];
  p.encodings[0].maxBitrate = spec.maxBitrate;
  try {
    await s.audioSender.setParameters(p);
  } catch {
    /* alguns navegadores não aceitam antes da negociação */
  }
}

function sendControl(s: Session, msg: unknown): void {
  if (s.control?.readyState === 'open') s.control.send(JSON.stringify(msg));
}

function sendMotion(s: Session, msg: unknown): void {
  if (s.motion?.readyState === 'open') s.motion.send(JSON.stringify(msg));
}

function wireChannel(s: Session, ch: RTCDataChannel, kind: 'control' | 'motion') {
  ch.onmessage = (e) => {
    if (typeof e.data !== 'string' || e.data.length > MAX_CHANNEL_MESSAGE) return;
    let msg: any;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!msg || typeof msg.k !== 'string') return;
    bridge.emit({ type: kind, sessionId: s.id, msg });
  };
  if (kind === 'control') {
    ch.onopen = () => bridge.emit({ type: 'channel-open', sessionId: s.id });
    ch.onclose = () => bridge.emit({ type: 'state', sessionId: s.id, state: 'closed' });
  }
}

async function start(cmd: Extract<EngineCommand, { type: 'start' }>): Promise<void> {
  const pc = new RTCPeerConnection({ iceServers: cmd.iceServers as RTCIceServer[], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
  const micEl = document.createElement('audio');
  micEl.autoplay = true;
  micEl.muted = true;
  document.body.appendChild(micEl);
  const s: Session = {
    id: cmd.sessionId,
    pc,
    stream: null,
    videoSender: null,
    audioSender: null,
    audioTrack: null,
    audioEnabled: false,
    audioQuality: cmd.audioQuality,
    control: null,
    motion: null,
    preset: cmd.quality,
    original: false,
    adaptive: new AdaptiveQualityController('balanced'),
    effective: 'balanced',
    stats: new OutboundStatsTracker(),
    statsTimer: null,
    pendingIce: [],
    remoteSet: false,
    micEl,
    micAllowed: false,
    remoteMic: null,
    recorder: null,
    audioCtx: null,
  };
  sessions.set(s.id, s);

  try {
    s.stream = await capture(cmd.captureAudio);
  } catch (err) {
    emitError(s.id, err);
    if (cmd.captureAudio) {
      s.stream = await capture(false); // sem áudio do sistema, mas mantém a tela
    } else {
      throw err;
    }
  }
  const video = s.stream.getVideoTracks()[0];
  video.contentHint = 'detail';
  s.audioTrack = s.stream.getAudioTracks()[0] ?? null;
  if (s.audioTrack) s.audioTrack.enabled = false;
  const vs = video.getSettings();
  bridge.emit({ type: 'capture', sessionId: s.id, width: vs.width || 0, height: vs.height || 0, audio: Boolean(s.audioTrack), label: video.label });

  const vt = pc.addTransceiver(video, { direction: 'sendonly', streams: [s.stream] });
  s.videoSender = vt.sender;
  try {
    const caps = RTCRtpSender.getCapabilities('video');
    if (caps && 'setCodecPreferences' in vt) vt.setCodecPreferences(sortCodecs(caps.codecs as any, cmd.codec) as RTCRtpCodec[]);
  } catch (err) {
    emitError(s.id, err);
  }
  const at = pc.addTransceiver('audio', { direction: 'sendrecv', streams: [s.stream] });
  s.audioSender = at.sender;
  if (s.audioTrack) await at.sender.replaceTrack(s.audioTrack);

  s.control = pc.createDataChannel(CONTROL_CHANNEL, { ordered: true });
  s.motion = pc.createDataChannel(MOTION_CHANNEL, { ordered: true, maxRetransmits: 0 });
  wireChannel(s, s.control, 'control');
  wireChannel(s, s.motion, 'motion');

  pc.onicecandidate = (e) => {
    bridge.emit({ type: 'signal', sessionId: s.id, payload: { k: 'ice', candidate: e.candidate ? (e.candidate.toJSON() as { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }) : null } });
  };
  pc.onconnectionstatechange = () => bridge.emit({ type: 'state', sessionId: s.id, state: pc.connectionState });
  pc.ontrack = (e) => {
    if (e.track.kind !== 'audio') return;
    s.remoteMic = e.streams[0] ?? new MediaStream([e.track]);
    s.micEl.srcObject = s.remoteMic;
    s.micEl.muted = !s.micAllowed;
    s.micEl.play().catch(() => undefined);
  };

  const offer = await pc.createOffer();
  const spec = AUDIO_PRESETS[s.audioQuality];
  offer.sdp = tuneOpus(offer.sdp || '', { stereo: spec.stereo, maxAverageBitrate: spec.maxBitrate });
  await pc.setLocalDescription(offer);
  bridge.emit({ type: 'signal', sessionId: s.id, payload: { k: 'sdp', type: 'offer', sdp: pc.localDescription!.sdp } });
  await applyQuality(s);
  await applyAudioParams(s);

  s.statsTimer = window.setInterval(() => void pollStats(s), 2000);
}

async function pollStats(s: Session): Promise<void> {
  if (s.pc.connectionState !== 'connected') return;
  const report = await s.pc.getStats();
  const sum = s.stats.summarize(report);
  if (!sum) return;
  if (s.preset === 'auto') {
    const changed = s.adaptive.evaluate({ availableKbps: sum.availableKbps, rttMs: sum.rttMs, lossPct: sum.lossPct, limitation: sum.limitation });
    if (changed) await applyQuality(s);
  }
  bridge.emit({ type: 'stats', sessionId: s.id, stats: sum, preset: s.preset, effective: s.effective });
}

async function onSignal(s: Session, payload: any): Promise<void> {
  if (payload.k === 'sdp' && payload.type === 'answer') {
    const spec = AUDIO_PRESETS[s.audioQuality];
    await s.pc.setRemoteDescription({ type: 'answer', sdp: tuneOpus(payload.sdp, { stereo: spec.stereo, maxAverageBitrate: spec.maxBitrate }) });
    s.remoteSet = true;
    for (const c of s.pendingIce.splice(0)) await s.pc.addIceCandidate(c).catch(() => undefined);
  } else if (payload.k === 'ice') {
    if (!payload.candidate) return;
    if (!s.remoteSet) s.pendingIce.push(payload.candidate);
    else await s.pc.addIceCandidate(payload.candidate).catch(() => undefined);
  }
}

async function switchDisplay(s: Session): Promise<void> {
  const fresh = await capture(Boolean(s.audioTrack));
  const nv = fresh.getVideoTracks()[0];
  nv.contentHint = 'detail';
  const old = s.stream;
  await s.videoSender?.replaceTrack(nv);
  const na = fresh.getAudioTracks()[0] ?? null;
  if (na) {
    na.enabled = s.audioEnabled;
    await s.audioSender?.replaceTrack(na);
  }
  s.stream = fresh;
  s.audioTrack = na ?? s.audioTrack;
  old?.getTracks().forEach((t) => {
    if (t !== s.audioTrack) t.stop();
  });
  const vs = nv.getSettings();
  bridge.emit({ type: 'capture', sessionId: s.id, width: vs.width || 0, height: vs.height || 0, audio: Boolean(na), label: nv.label });
  await applyQuality(s);
}

/** Monta o fluxo gravado: vídeo da tela + (opcional) áudio do sistema mixado com o microfone remoto. */
function recordingStream(s: Session, includeAudio: boolean): MediaStream {
  const tracks: MediaStreamTrack[] = [s.stream!.getVideoTracks()[0]];
  if (includeAudio) {
    const sources: MediaStream[] = [];
    if (s.audioTrack) sources.push(new MediaStream([s.audioTrack]));
    if (s.remoteMic && s.micAllowed) sources.push(s.remoteMic);
    if (sources.length === 1) tracks.push(sources[0].getAudioTracks()[0]);
    else if (sources.length > 1) {
      s.audioCtx = new AudioContext();
      const dest = s.audioCtx.createMediaStreamDestination();
      for (const src of sources) s.audioCtx.createMediaStreamSource(src).connect(dest);
      tracks.push(dest.stream.getAudioTracks()[0]);
    }
  }
  return new MediaStream(tracks);
}

async function stop(s: Session): Promise<void> {
  if (s.statsTimer) clearInterval(s.statsTimer);
  if (s.recorder) {
    await s.recorder.stop().catch(() => undefined);
    s.recorder = null;
    bridge.emit({ type: 'rec-state', sessionId: s.id, state: 'stopped' });
  }
  s.audioCtx?.close().catch(() => undefined);
  s.stream?.getTracks().forEach((t) => t.stop());
  s.pc.close();
  s.micEl.remove();
  sessions.delete(s.id);
}

async function handle(cmd: EngineCommand): Promise<void> {
  if (cmd.type === 'start') return start(cmd);
  const s = sessions.get(cmd.sessionId);
  if (!s) return;
  switch (cmd.type) {
    case 'signal':
      return onSignal(s, cmd.payload);
    case 'send':
      return cmd.channel === 'motion' ? sendMotion(s, cmd.msg) : sendControl(s, cmd.msg);
    case 'quality':
      s.preset = cmd.preset;
      s.original = cmd.original;
      return applyQuality(s);
    case 'audio':
      s.audioEnabled = cmd.enabled && Boolean(s.audioTrack);
      if (s.audioTrack) s.audioTrack.enabled = s.audioEnabled;
      if (cmd.quality) {
        s.audioQuality = cmd.quality;
        await applyAudioParams(s);
      }
      sendControl(s, { k: 'audio.state', enabled: s.audioEnabled, available: Boolean(s.audioTrack) });
      return;
    case 'mic':
      s.micAllowed = cmd.allowed;
      s.micEl.muted = !cmd.allowed;
      if (cmd.allowed) s.micEl.play().catch(() => undefined);
      return;
    case 'display':
      return switchDisplay(s);
    case 'rec-start': {
      if (s.recorder) return;
      const rec = new SessionRecorder();
      s.recorder = rec;
      rec.start(recordingStream(s, cmd.includeAudio), {
        quality: cmd.quality,
        onChunk: async (blob) => bridge.recChunk(s.id, await blob.arrayBuffer()),
        onError: (err) => bridge.emit({ type: 'rec-state', sessionId: s.id, state: 'error', message: String(err) }),
      });
      bridge.emit({ type: 'rec-state', sessionId: s.id, state: 'recording', mime: rec.mimeType });
      return;
    }
    case 'rec-pause':
      s.recorder?.pause();
      bridge.emit({ type: 'rec-state', sessionId: s.id, state: 'paused' });
      return;
    case 'rec-resume':
      s.recorder?.resume();
      bridge.emit({ type: 'rec-state', sessionId: s.id, state: 'recording' });
      return;
    case 'rec-stop':
      if (s.recorder) {
        await s.recorder.stop();
        s.recorder = null;
        s.audioCtx?.close().catch(() => undefined);
        s.audioCtx = null;
      }
      bridge.emit({ type: 'rec-state', sessionId: s.id, state: 'stopped' });
      return;
    case 'stop':
      return stop(s);
  }
}

bridge.onCommand((cmd) => {
  handle(cmd).catch((err) => emitError((cmd as any).sessionId || '', err));
});
bridge.emit({ type: 'ready' });
