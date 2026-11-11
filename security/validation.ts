/** Validações simples reutilizadas por servidor, host e cliente. */
export function clampString(value: unknown, max: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const v = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return v.slice(0, max);
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Regras mínimas para senha de acesso não assistido. */
export function checkAccessPassword(pw: string): string | null {
  if (typeof pw !== 'string' || pw.length < 8) return 'A senha deve ter pelo menos 8 caracteres.';
  if (pw.length > 128) return 'A senha deve ter no máximo 128 caracteres.';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 2) return 'Use pelo menos dois tipos de caracteres (letras, números, símbolos).';
  return null;
}
