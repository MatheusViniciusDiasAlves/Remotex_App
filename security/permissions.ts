/**
 * Modelo de permissões do RemoteX.
 *
 * Permissão efetiva de uma sessão = política global do computador ∩ permissões concedidas ao dispositivo.
 * "view" (ver a tela) é a permissão mínima de qualquer sessão autorizada.
 */
export const PERMISSION_KEYS = [
  'view',
  'control',
  'keyboard',
  'clipboard',
  'audio',
  'microphone',
  'recording',
  'admin',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export type PermissionSet = Record<PermissionKey, boolean>;

export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  view: 'Ver a tela',
  control: 'Controlar mouse',
  keyboard: 'Usar teclado e atalhos',
  clipboard: 'Área de transferência (copiar/colar)',
  audio: 'Ouvir o áudio do computador',
  microphone: 'Enviar microfone do celular',
  recording: 'Gravar a sessão',
  admin: 'Administração remota (permissões, dispositivos, histórico)',
};

export function permissionSet(partial: Partial<PermissionSet> = {}): PermissionSet {
  const out = {} as PermissionSet;
  for (const k of PERMISSION_KEYS) out[k] = Boolean(partial[k]);
  out.view = true;
  return out;
}

/** Permissões padrão sugeridas ao aprovar um novo dispositivo. */
export const DEFAULT_GRANT: PermissionSet = permissionSet({
  view: true,
  control: true,
  keyboard: true,
  clipboard: true,
  audio: true,
  microphone: false,
  recording: false,
  admin: false,
});

/** Política global padrão do computador (o que PODE ser liberado remotamente). */
export const DEFAULT_POLICY: PermissionSet = permissionSet({
  view: true,
  control: true,
  keyboard: true,
  clipboard: true,
  audio: true,
  microphone: true,
  recording: true,
  admin: true,
});

export function intersect(a: PermissionSet, b: Partial<PermissionSet>): PermissionSet {
  const out = {} as PermissionSet;
  for (const k of PERMISSION_KEYS) out[k] = Boolean(a[k] && b[k]);
  out.view = true;
  return out;
}

export function sanitizePermissions(input: unknown): PermissionSet {
  if (!input || typeof input !== 'object') return permissionSet();
  const src = input as Record<string, unknown>;
  const partial: Partial<PermissionSet> = {};
  for (const k of PERMISSION_KEYS) partial[k] = src[k] === true;
  return permissionSet(partial);
}

export function describePermissions(p: PermissionSet): string {
  return PERMISSION_KEYS.filter((k) => p[k]).map((k) => PERMISSION_LABELS[k]).join(', ');
}
