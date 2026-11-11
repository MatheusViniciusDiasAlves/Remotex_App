import { describe, expect, it } from 'vitest';
import { AdaptiveQualityController, encodingFor } from '@remotex/media/quality';
import { sortCodecs, tuneOpus } from '@remotex/media/codecs';
import { InboundStatsTracker, qualityBars } from '@remotex/media/stats';
import { recordingFileName, pickRecordingMime } from '@remotex/recording/recorder';

describe('qualidade', () => {
  it('reduz resolução de telas 4K nos presets equilibrado/econômico', () => {
    const src = { width: 3840, height: 2160 };
    expect(encodingFor('balanced', src).scaleResolutionDownBy).toBe(2);
    expect(encodingFor('economy', src).scaleResolutionDownBy).toBe(3);
    expect(encodingFor('high', src).scaleResolutionDownBy).toBe(1);
    expect(encodingFor('economy', src, { original: true }).scaleResolutionDownBy).toBe(1);
    expect(encodingFor('balanced', { width: 1920, height: 1080 }).scaleResolutionDownBy).toBe(1);
  });
  it('controlador adaptativo rebaixa rápido e promove devagar', () => {
    const c = new AdaptiveQualityController('balanced');
    expect(c.evaluate({ availableKbps: 800, rttMs: 100, lossPct: 0 })).toBeNull();
    expect(c.evaluate({ availableKbps: 800, rttMs: 100, lossPct: 0 })).toBe('economy');
    const good = { availableKbps: 20000, rttMs: 30, lossPct: 0 };
    for (let i = 0; i < 4; i++) expect(c.evaluate(good)).toBeNull();
    expect(c.evaluate(good)).toBe('balanced');
    for (let i = 0; i < 4; i++) c.evaluate(good);
    expect(c.evaluate(good)).toBe('high');
    for (let i = 0; i < 10; i++) expect(c.evaluate(good)).toBeNull();
  });
  it('respeita teto', () => {
    const c = new AdaptiveQualityController('economy', 'balanced');
    const good = { availableKbps: 50000, rttMs: 10, lossPct: 0 };
    for (let i = 0; i < 30; i++) c.evaluate(good);
    expect(c.current).toBe('balanced');
  });
});

describe('codecs', () => {
  it('prioriza H.264 packetization-mode=1 baseline', () => {
    const caps = [
      { mimeType: 'video/VP8', clockRate: 90000 },
      { mimeType: 'video/rtx', clockRate: 90000 },
      { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=0;profile-level-id=42e01f' },
      { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=1;profile-level-id=4d001f' },
      { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' },
      { mimeType: 'video/VP9', clockRate: 90000 },
    ];
    const s = sortCodecs(caps);
    expect(s[0].sdpFmtpLine).toBe('packetization-mode=1;profile-level-id=42e01f');
    expect(s.at(-1)!.mimeType).toBe('video/rtx');
    expect(sortCodecs(caps, 'vp9')[0].mimeType).toBe('video/VP9');
  });
  it('ajusta fmtp do Opus', () => {
    const sdp = 'a=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n';
    const out = tuneOpus(sdp, { stereo: true, maxAverageBitrate: 128000 });
    expect(out).toContain('a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000');
  });
});

describe('estatísticas', () => {
  it('calcula taxa, perda e caminho', () => {
    const t = new InboundStatsTracker();
    const mk = (ts: number, bytes: number, lost: number, recv: number) =>
      new Map<string, any>([
        ['T', { id: 'T', type: 'transport', selectedCandidatePairId: 'P' }],
        ['P', { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.042 }],
        ['L', { id: 'L', type: 'local-candidate', candidateType: 'host' }],
        ['R', { id: 'R', type: 'remote-candidate', candidateType: 'relay' }],
        ['C', { id: 'C', type: 'codec', mimeType: 'video/H264' }],
        ['V', { id: 'V', type: 'inbound-rtp', kind: 'video', codecId: 'C', timestamp: ts, bytesReceived: bytes, packetsLost: lost, packetsReceived: recv, framesPerSecond: 30, frameWidth: 1280, frameHeight: 720 }],
      ]);
    t.summarize(mk(0, 0, 0, 0));
    const s = t.summarize(mk(1000, 125000, 5, 95))!;
    expect(s.kbps).toBe(1000);
    expect(s.lossPct).toBe(5);
    expect(s.rttMs).toBe(42);
    expect(s.path).toBe('relay');
    expect(s.codec).toBe('H264');
    expect(qualityBars({ rttMs: 42, lossPct: 0, fps: 30 })).toBe(4);
    expect(qualityBars({ rttMs: 600, lossPct: 10, fps: 5 })).toBe(0);
  });
});

describe('gravação', () => {
  it('escolhe formato suportado e nomeia arquivos', () => {
    expect(pickRecordingMime((t) => t.startsWith('video/webm;codecs=vp8'))).toBe('video/webm;codecs=vp8,opus');
    expect(recordingFileName('RemoteX', 'video/mp4', new Date(2026, 0, 2, 3, 4, 5))).toBe('RemoteX-20260102-030405.mp4');
  });
});
