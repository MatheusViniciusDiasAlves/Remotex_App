/**
 * Modo MOUSE (touchpad virtual): converte o deslocamento do dedo no celular em deslocamento do
 * cursor no computador, com aceleração dependente da velocidade (movimentos lentos = precisão,
 * movimentos rápidos = atravessar a tela).
 */
export interface TouchpadConfig {
  /** Sensibilidade base (1 = padrão). */
  sensitivity: number;
  /** Intensidade da aceleração (0 = linear). */
  acceleration: number;
}

export const DEFAULT_TOUCHPAD: TouchpadConfig = { sensitivity: 1, acceleration: 1 };

/**
 * @param dxCss deslocamento horizontal do dedo em px CSS
 * @param dyCss deslocamento vertical do dedo em px CSS
 * @param dtMs  intervalo desde a amostra anterior
 * @param remote tamanho da tela remota em pixels
 * @returns deslocamento normalizado (fração da tela remota)
 */
export function touchpadDelta(
  dxCss: number,
  dyCss: number,
  dtMs: number,
  remote: { width: number; height: number },
  cfg: TouchpadConfig = DEFAULT_TOUCHPAD,
): { dx: number; dy: number } {
  const dist = Math.hypot(dxCss, dyCss);
  const velocity = dist / Math.max(1, dtMs); // px/ms
  const accel = 1 + cfg.acceleration * Math.min(2.5, Math.max(0, velocity - 0.15) * 2.2);
  const gain = 1.6 * cfg.sensitivity * accel; // px remotos por px CSS
  return {
    dx: (dxCss * gain) / Math.max(1, remote.width),
    dy: (dyCss * gain) / Math.max(1, remote.height),
  };
}

/** Converte deslocamento de dois dedos (px CSS) em unidades de roda (120 = 1 clique). */
export function scrollToWheel(dCss: number, factor = 4): number {
  return dCss * factor;
}
