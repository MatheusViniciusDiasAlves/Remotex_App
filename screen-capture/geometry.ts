/**
 * Geometria de telas: converte coordenadas normalizadas (0..1) do vídeo recebido no celular
 * para pixels físicos do desktop virtual do computador, considerando múltiplos monitores,
 * monitores com coordenadas negativas e escala de DPI.
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Normalizado → pixel físico dentro do monitor capturado. */
export function normalizedToDesktop(nx: number, ny: number, display: Rect): { x: number; y: number } {
  const x = display.x + Math.round(clamp01(nx) * (display.width - 1));
  const y = display.y + Math.round(clamp01(ny) * (display.height - 1));
  return { x, y };
}

/** Pixel físico → normalizado relativo ao monitor (para enviar a posição do cursor ao celular). */
export function desktopToNormalized(x: number, y: number, display: Rect): { x: number; y: number; inside: boolean } {
  const nx = (x - display.x) / Math.max(1, display.width - 1);
  const ny = (y - display.y) / Math.max(1, display.height - 1);
  return { x: clamp01(nx), y: clamp01(ny), inside: nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1 };
}

/**
 * SendInput com MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK espera coordenadas 0..65535
 * mapeadas sobre todo o desktop virtual.
 */
export function toWindowsAbsolute(x: number, y: number, virtualScreen: Rect): { dx: number; dy: number } {
  const w = Math.max(1, virtualScreen.width - 1);
  const h = Math.max(1, virtualScreen.height - 1);
  const dx = Math.round(((x - virtualScreen.x) * 65535) / w);
  const dy = Math.round(((y - virtualScreen.y) * 65535) / h);
  return { dx: Math.min(65535, Math.max(0, dx)), dy: Math.min(65535, Math.max(0, dy)) };
}

export function unionRect(rects: Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let x1 = Infinity,
    y1 = Infinity,
    x2 = -Infinity,
    y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.width);
    y2 = Math.max(y2, r.y + r.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
