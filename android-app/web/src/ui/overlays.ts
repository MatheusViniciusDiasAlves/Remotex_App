/** Componentes sobrepostos do app: avisos (toast), folhas inferiores (sheets) e diálogos. */
import { h } from '@remotex/shared/dom';

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: 'info' | 'ok' | 'warn' | 'error' = 'info', ms = 3500): void {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const el = h('div', { class: `toast ${kind}`, 'data-testid': 'toast' }, message);
  toastHost.append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

export interface Sheet {
  el: HTMLElement;
  body: HTMLElement;
  close(): void;
}

let openSheets: Sheet[] = [];

export function openSheet(title: string, content: Node | Node[], opts: { onClose?: () => void; testid?: string; wide?: boolean } = {}): Sheet {
  const body = h('div', { class: 'sheet-body' });
  body.append(...(Array.isArray(content) ? content : [content]));
  const panel = h(
    'div',
    { class: 'sheet' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-label': title, 'data-testid': opts.testid },
    h('div', { class: 'sheet-grip' }),
    h('div', { class: 'sheet-head' }, h('h3', null, title), h('button', { class: 'icon-btn', 'aria-label': 'Fechar', onclick: () => sheet.close() }, '✕')),
    body,
  );
  const backdrop = h('div', { class: 'sheet-backdrop' }, panel);
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) sheet.close();
  });
  const sheet: Sheet = {
    el: backdrop,
    body,
    close() {
      if (!backdrop.isConnected) return;
      backdrop.classList.add('closing');
      setTimeout(() => backdrop.remove(), 180);
      openSheets = openSheets.filter((s) => s !== sheet);
      opts.onClose?.();
    },
  };
  document.body.append(backdrop);
  openSheets.push(sheet);
  return sheet;
}

export function closeAllSheets(): void {
  for (const s of [...openSheets]) s.close();
}

export function confirmDialog(title: string, message: string, opts: { ok?: string; cancel?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      sheet.close();
      resolve(v);
    };
    const sheet = openSheet(title, [
      h('p', { class: 'dialog-text' }, message),
      h(
        'div',
        { class: 'row-actions' },
        h('button', { class: 'btn ghost', onclick: () => finish(false) }, opts.cancel ?? 'Cancelar'),
        h('button', { class: 'btn ' + (opts.danger ? 'danger' : 'primary'), 'data-testid': 'dialog-ok', onclick: () => finish(true) }, opts.ok ?? 'Confirmar'),
      ),
    ], { onClose: () => finish(false) });
  });
}

export function field(label: string, input: HTMLElement, help?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, help ? h('span', { class: 'field-help' }, help) : null);
}

export function switchRow(label: string, checked: boolean, onChange: (v: boolean) => void, help?: string, testid?: string): HTMLElement {
  const input = h('input', { type: 'checkbox', checked, 'data-testid': testid });
  input.addEventListener('change', () => onChange(input.checked));
  return h(
    'label',
    { class: 'switch-row' },
    h('div', { class: 'switch-text' }, h('span', null, label), help ? h('small', null, help) : null),
    h('span', { class: 'switch' }, input, h('span', { class: 'slider' })),
  );
}

export function segmented<T extends string>(options: Array<[T, string]>, value: T, onChange: (v: T) => void, testid?: string): HTMLElement {
  const wrap = h('div', { class: 'segmented', role: 'radiogroup', 'data-testid': testid });
  for (const [v, label] of options) {
    const b = h('button', { class: 'seg' + (v === value ? ' active' : ''), role: 'radio', 'aria-checked': String(v === value), dataset: { value: v } }, label);
    b.addEventListener('click', () => {
      wrap.querySelectorAll('.seg').forEach((x) => {
        x.classList.toggle('active', x === b);
        x.setAttribute('aria-checked', String(x === b));
      });
      onChange(v);
    });
    wrap.append(b);
  }
  return wrap;
}
