/**
 * Preferência de codecs. H.264 primeiro: codificação por hardware no Windows (Media Foundation /
 * NVENC/QuickSync/AMF via Chromium) e decodificação por hardware em praticamente todo celular.
 * VP9/VP8/AV1 ficam como alternativas (VP9 tem ótima nitidez de texto, mas custa mais CPU).
 */
export type VideoCodecPref = 'auto' | 'h264' | 'vp9' | 'vp8' | 'av1';

const ORDER: Record<VideoCodecPref, string[]> = {
  auto: ['video/H264', 'video/VP9', 'video/VP8', 'video/AV1'],
  h264: ['video/H264', 'video/VP8'],
  vp9: ['video/VP9', 'video/H264', 'video/VP8'],
  vp8: ['video/VP8', 'video/H264'],
  av1: ['video/AV1', 'video/VP9', 'video/H264', 'video/VP8'],
};

export interface CodecCap {
  mimeType: string;
  clockRate: number;
  channels?: number;
  sdpFmtpLine?: string;
}

export function sortCodecs<T extends CodecCap>(codecs: T[], pref: VideoCodecPref = 'auto'): T[] {
  const order = ORDER[pref] || ORDER.auto;
  const rank = (c: T) => {
    const i = order.findIndex((m) => m.toLowerCase() === c.mimeType.toLowerCase());
    if (i < 0) return 1000; // RTX/RED/ULPFEC mantidos ao final
    let r = i * 10;
    // H.264: preferir packetization-mode=1 e perfil constrained baseline (mais compatível).
    if (c.mimeType.toLowerCase() === 'video/h264') {
      const f = c.sdpFmtpLine || '';
      if (!/packetization-mode=1/.test(f)) r += 5;
      if (!/profile-level-id=42e0/i.test(f)) r += 1;
    }
    return r;
  };
  return [...codecs].sort((a, b) => rank(a) - rank(b));
}

/** Ativa estéreo e define taxa média do Opus no SDP (fmtp). */
export function tuneOpus(sdp: string, opts: { stereo: boolean; maxAverageBitrate: number }): string {
  const m = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp);
  if (!m) return sdp;
  const pt = m[1];
  const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  const params: Record<string, string> = {};
  const existing = re.exec(sdp);
  if (existing) {
    for (const kv of existing[1].split(';')) {
      const [k, v] = kv.split('=').map((s) => s.trim());
      if (k) params[k] = v ?? '';
    }
  }
  params.stereo = opts.stereo ? '1' : '0';
  params['sprop-stereo'] = opts.stereo ? '1' : '0';
  params.maxaveragebitrate = String(opts.maxAverageBitrate);
  params.useinbandfec = '1';
  const line = `a=fmtp:${pt} ${Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join(';')}`;
  if (existing) return sdp.replace(re, line);
  return sdp.replace(new RegExp(`(a=rtpmap:${pt} opus/48000/2[^\\r\\n]*)`, 'i'), `$1\r\n${line}`);
}
