/** Extração de métricas de RTCStatsReport para indicador de qualidade e controle adaptativo. */
export type PathType = 'direct-lan' | 'direct-internet' | 'relay' | 'unknown';

export interface InboundSummary {
  fps: number;
  kbps: number;
  rttMs: number | null;
  lossPct: number;
  jitterMs: number;
  decodeMs: number;
  width: number;
  height: number;
  path: PathType;
  codec: string;
}

export interface OutboundSummary {
  fps: number;
  kbps: number;
  rttMs: number | null;
  availableKbps: number | null;
  lossPct: number | null;
  limitation: string | null;
  width: number;
  height: number;
  path: PathType;
  codec: string;
  encoder: string;
}

type AnyStats = Record<string, any>;

function values(report: RTCStatsReport | Map<string, AnyStats>): AnyStats[] {
  const out: AnyStats[] = [];
  report.forEach((v: AnyStats) => out.push(v));
  return out;
}

function selectedPair(all: AnyStats[]): AnyStats | undefined {
  const transport = all.find((s) => s.type === 'transport' && s.selectedCandidatePairId);
  if (transport) return all.find((s) => s.id === transport.selectedCandidatePairId);
  return all.find((s) => s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected));
}

function pathOf(all: AnyStats[], pair: AnyStats | undefined): PathType {
  if (!pair) return 'unknown';
  const local = all.find((s) => s.id === pair.localCandidateId);
  const remote = all.find((s) => s.id === pair.remoteCandidateId);
  const types = [local?.candidateType, remote?.candidateType];
  if (types.includes('relay')) return 'relay';
  if (types.every((t) => t === 'host')) return 'direct-lan';
  if (types.some((t) => t === 'srflx' || t === 'prflx')) return 'direct-internet';
  return 'unknown';
}

function codecOf(all: AnyStats[], rtp: AnyStats | undefined): string {
  const c = rtp && all.find((s) => s.id === rtp.codecId);
  return c?.mimeType ? String(c.mimeType).split('/')[1] : '';
}

export class InboundStatsTracker {
  private prevBytes = 0;
  private prevTs: number | null = null;
  private prevLost = 0;
  private prevRecv = 0;

  summarize(report: RTCStatsReport | Map<string, AnyStats>): InboundSummary | null {
    const all = values(report);
    const rtp = all.find((s) => s.type === 'inbound-rtp' && (s.kind === 'video' || s.mediaType === 'video'));
    if (!rtp) return null;
    const pair = selectedPair(all);
    const ts = rtp.timestamp;
    const bytes = rtp.bytesReceived || 0;
    const dt = this.prevTs !== null ? (ts - this.prevTs) / 1000 : 0;
    const kbps = dt > 0 ? ((bytes - this.prevBytes) * 8) / 1000 / dt : 0;
    const lost = rtp.packetsLost || 0;
    const recv = rtp.packetsReceived || 0;
    const dLost = lost - this.prevLost;
    const dRecv = recv - this.prevRecv;
    const lossPct = dLost + dRecv > 0 ? (Math.max(0, dLost) / (dLost + dRecv)) * 100 : 0;
    this.prevBytes = bytes;
    this.prevTs = ts;
    this.prevLost = lost;
    this.prevRecv = recv;
    return {
      fps: rtp.framesPerSecond || 0,
      kbps: Math.max(0, Math.round(kbps)),
      rttMs: pair?.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
      lossPct: Math.round(lossPct * 10) / 10,
      jitterMs: Math.round((rtp.jitter || 0) * 1000),
      decodeMs: rtp.framesDecoded ? Math.round(((rtp.totalDecodeTime || 0) / rtp.framesDecoded) * 1000 * 10) / 10 : 0,
      width: rtp.frameWidth || 0,
      height: rtp.frameHeight || 0,
      path: pathOf(all, pair),
      codec: codecOf(all, rtp),
    };
  }
}

export class OutboundStatsTracker {
  private prevBytes = 0;
  private prevTs: number | null = null;

  summarize(report: RTCStatsReport | Map<string, AnyStats>): OutboundSummary | null {
    const all = values(report);
    const rtp = all.find((s) => s.type === 'outbound-rtp' && (s.kind === 'video' || s.mediaType === 'video'));
    if (!rtp) return null;
    const pair = selectedPair(all);
    const remoteIn = all.find((s) => s.type === 'remote-inbound-rtp' && s.localId === rtp.id);
    const ts = rtp.timestamp;
    const bytes = rtp.bytesSent || 0;
    const dt = this.prevTs !== null ? (ts - this.prevTs) / 1000 : 0;
    const kbps = dt > 0 ? ((bytes - this.prevBytes) * 8) / 1000 / dt : 0;
    this.prevBytes = bytes;
    this.prevTs = ts;
    return {
      fps: rtp.framesPerSecond || 0,
      kbps: Math.max(0, Math.round(kbps)),
      rttMs: pair?.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
      availableKbps: pair?.availableOutgoingBitrate != null ? Math.round(pair.availableOutgoingBitrate / 1000) : null,
      lossPct: remoteIn?.fractionLost != null ? Math.round(remoteIn.fractionLost * 1000) / 10 : null,
      limitation: rtp.qualityLimitationReason || null,
      width: rtp.frameWidth || 0,
      height: rtp.frameHeight || 0,
      path: pathOf(all, pair),
      codec: codecOf(all, rtp),
      encoder: rtp.encoderImplementation || '',
    };
  }
}

/** Nota de 0 a 4 barras para o indicador de qualidade da conexão. */
export function qualityBars(s: { rttMs: number | null; lossPct: number | null; fps: number }): number {
  let score = 4;
  const rtt = s.rttMs ?? 100;
  if (rtt > 120) score--;
  if (rtt > 250) score--;
  if (rtt > 500) score--;
  const loss = s.lossPct ?? 0;
  if (loss > 2) score--;
  if (loss > 8) score--;
  if (s.fps > 0 && s.fps < 8) score--;
  return Math.max(0, Math.min(4, score));
}
