/**
 * Diferença entre o conteúdo anterior e o atual do campo oculto ligado ao teclado nativo do
 * Android. Teclados como o Gboard compõem palavras, aplicam autocorreção e sugestões alterando
 * o texto já digitado; em vez de depender de eventos de tecla (que no Android chegam como
 * keyCode 229), comparamos o texto e enviamos ao PC apenas "N backspaces + texto novo".
 * Opera em code points para não partir emojis/acentos combinados.
 */
export interface TextDiff {
  backspaces: number;
  insert: string;
}

export function diffText(prev: string, next: string): TextDiff {
  const a = Array.from(prev);
  const b = Array.from(next);
  let i = 0;
  const max = Math.min(a.length, b.length);
  while (i < max && a[i] === b[i]) i++;
  return { backspaces: a.length - i, insert: b.slice(i).join('') };
}

/** Normaliza quebras de linha e remove caracteres de controle (exceto \n e \t). */
export function sanitizeTypedText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}
