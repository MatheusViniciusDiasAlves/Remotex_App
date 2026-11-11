/**
 * Telas do aplicativo RemoteX (celular): Início, Dispositivos, Histórico e Ajustes.
 */
import { clear, h } from '@remotex/shared/dom';
import { formatDeviceId, isValidDeviceId, normalizeDeviceId } from '@remotex/shared/ids';
import { keyFingerprint } from '@remotex/auth/device-keys';
import { APP_VERSION } from '@remotex/shared/version';
import { api, ApiError, ensureIdentity } from '../core/api';
import { ClientSignaling, type SigStatus } from '../core/signaling';
import { RemoteConnection } from '../core/connection';
import { store, type ControlMode } from '../core/storage';
import { isNativeApp } from '../core/native';
import { SessionView } from '../session/session-view';
import { confirmDialog, field, openSheet, segmented, switchRow, toast } from './overlays';

type Tab = 'home' | 'devices' | 'history' | 'settings';

export class App {
  private root: HTMLElement;
  private content: HTMLElement;
  private nav: HTMLElement;
  private tab: Tab = 'home';
  private sig: ClientSignaling;
  private session: SessionView | null = null;
  private presence: Record<string, boolean> = {};
  private serverStatus: SigStatus | 'error' = 'offline';
  private identityError = '';

  constructor(root: HTMLElement) {
    this.root = root;
    this.sig = new ClientSignaling(
      () => store.settings().serverUrl,
      () => store.identity(),
      () => store.settings().deviceName,
    );
    this.sig.on('status', (s) => {
      this.serverStatus = s;
      if (s === 'online') this.refreshPresence();
      this.renderHeaderStatus();
    });
    this.sig.on('message', (m) => {
      if (m.t === 'presence') {
        this.presence = { ...this.presence, ...m.statuses };
        this.updatePresence();
      }
    });
    this.content = h('main', { class: 'app-content' });
    this.nav = h('nav', { class: 'bottom-nav' });
    root.append(this.content, this.nav);
    window.addEventListener('hashchange', () => this.route());
    this.route();
    void this.boot();
  }

  private async boot(): Promise<void> {
    try {
      await ensureIdentity();
      this.identityError = '';
      await this.sig.open().catch(() => undefined);
    } catch (err) {
      this.serverStatus = 'error';
      this.identityError = err instanceof ApiError ? err.message : String(err);
      this.render();
    }
    setInterval(() => this.refreshPresence(), 20_000);
  }

  private refreshPresence(): void {
    const ids = store.favorites().map((f) => f.hostId);
    if (ids.length && this.sig.status === 'online') this.sig.send({ t: 'presence.query', ids });
  }

  private route(): void {
    const h0 = location.hash.replace(/^#\/?/, '');
    if (h0.startsWith('connect/')) {
      const id = normalizeDeviceId(h0.slice(8));
      history.replaceState(null, '', '#/home');
      if (isValidDeviceId(id)) void this.connect(id);
      return;
    }
    this.tab = (['home', 'devices', 'history', 'settings'].includes(h0) ? h0 : 'home') as Tab;
    this.render();
  }

  private go(tab: Tab): void {
    location.hash = `#/${tab}`;
  }

  render(): void {
    if (this.session) return;
    // Preserva o que o usuário está digitando (ex.: ID) quando a tela é atualizada em segundo plano.
    const idInput = this.content.querySelector<HTMLInputElement>('[data-testid=host-id-input]');
    const typed = idInput?.value ?? '';
    const hadFocus = idInput !== null && document.activeElement === idInput;
    clear(this.content);
    const pages: Record<Tab, () => Node[]> = {
      home: () => this.pageHome(),
      devices: () => this.pageDevices(),
      history: () => this.pageHistory(),
      settings: () => this.pageSettings(),
    };
    this.content.append(...pages[this.tab]());
    this.renderNav();
    const fresh = this.content.querySelector<HTMLInputElement>('[data-testid=host-id-input]');
    if (fresh && typed) {
      fresh.value = typed;
      fresh.dispatchEvent(new Event('input'));
      if (hadFocus) fresh.focus();
    }
  }

  private renderNav(): void {
    clear(this.nav);
    const items: Array<[Tab, string, string]> = [
      ['home', 'Início', '⌂'],
      ['devices', 'Dispositivos', '▣'],
      ['history', 'Histórico', '↺'],
      ['settings', 'Ajustes', '⚙'],
    ];
    for (const [t, label, icon] of items) {
      this.nav.append(
        h('button', { class: 'nav-btn' + (t === this.tab ? ' active' : ''), 'data-testid': `tab-${t}`, onclick: () => this.go(t) }, h('span', { class: 'nav-icon' }, icon), h('span', null, label)),
      );
    }
  }

  private header(title: string): HTMLElement {
    return h(
      'header',
      { class: 'app-header' },
      h('div', { class: 'brand' }, h('div', { class: 'logo' }, 'R'), h('div', null, h('div', { class: 'brand-name' }, title === 'RemoteX' ? 'RemoteX' : title), title === 'RemoteX' ? h('div', { class: 'brand-sub' }, 'Controle seu computador pelo celular') : null)),
      h('div', { class: 'server-status', id: 'server-status' }),
    );
  }

  private renderHeaderStatus(): void {
    const el = document.getElementById('server-status');
    if (!el) return;
    const map: Record<string, [string, string]> = {
      online: ['online', 'Servidor conectado'],
      connecting: ['connecting', 'Conectando…'],
      offline: ['offline', 'Sem conexão'],
      unauthorized: ['error', 'Não autorizado'],
      error: ['error', 'Servidor indisponível'],
    };
    const [cls, text] = map[this.serverStatus] ?? map.offline;
    clear(el);
    el.append(h('span', { class: `dot ${cls}`, 'data-testid': 'server-dot', 'data-status': this.serverStatus }), h('span', null, text));
  }

  // =========================================================================================
  // Início
  // =========================================================================================
  private pageHome(): Node[] {
    const input = h('input', {
      class: 'id-input',
      inputmode: 'numeric',
      autocomplete: 'off',
      placeholder: '000 000 000',
      maxlength: 11,
      'aria-label': 'ID do computador',
      'data-testid': 'host-id-input',
    }) as HTMLInputElement;
    const hint = h('div', { class: 'id-hint' });
    const btn = h('button', { class: 'btn primary big', 'data-testid': 'connect-btn', disabled: true }, 'Conectar') as HTMLButtonElement;
    const validate = () => {
      const digits = normalizeDeviceId(input.value).slice(0, 9);
      input.value = formatDeviceId(digits);
      const ok = isValidDeviceId(digits);
      btn.disabled = !ok;
      hint.textContent = digits.length === 9 && !ok ? 'ID inválido — confira os dígitos.' : '';
    };
    input.addEventListener('input', validate);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && !btn.disabled && btn.click());
    btn.addEventListener('click', () => void this.connect(normalizeDeviceId(input.value)));

    const favs = store.favorites();
    const recent = store.history().slice(0, 4);
    setTimeout(() => this.renderHeaderStatus());
    return [
      this.header('RemoteX'),
      this.identityError ? h('div', { class: 'alert error' }, this.identityError, ' ', h('a', { href: '#/settings' }, 'Verificar servidor')) : null,
      h(
        'section',
        { class: 'card connect-card' },
        h('h2', null, 'Conectar a um computador'),
        h('p', { class: 'muted small' }, 'Digite o ID RemoteX exibido no programa do computador.'),
        input,
        hint,
        btn,
      ),
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, 'Computadores'), favs.length ? h('span', { class: 'muted small' }, `${favs.length}`) : null),
        favs.length
          ? h(
              'div',
              { class: 'list' },
              ...favs.map((f) => {
                const online = this.presence[f.hostId];
                const pin = store.pin(f.hostId);
                return h(
                  'div',
                  { class: 'host-item', 'data-testid': 'favorite', dataset: { host: f.hostId } },
                  h(
                    'button',
                    { class: 'host-main', onclick: () => void this.connect(f.hostId) },
                    h('span', { class: 'host-icon' }, '🖥'),
                    h(
                      'span',
                      { class: 'host-text' },
                      h('strong', null, f.name),
                      h(
                        'small',
                        null,
                        `${formatDeviceId(f.hostId)} • `,
                        h('span', { class: 'presence-text' }, online === undefined ? '—' : online ? 'online' : 'offline'),
                        pin?.trustedUnattended ? ' • confiável' : '',
                      ),
                    ),
                    h('span', { class: 'dot ' + (online ? 'online' : 'offline') }),
                  ),
                  h('button', { class: 'icon-btn', 'aria-label': 'Opções', onclick: () => this.favoriteMenu(f.hostId) }, '⋮'),
                );
              }),
            )
          : h('p', { class: 'muted small' }, 'Os computadores que você acessar aparecerão aqui.'),
      ),
      recent.length
        ? h(
            'section',
            { class: 'card' },
            h('div', { class: 'card-head' }, h('h2', null, 'Sessões recentes'), h('a', { href: '#/history', class: 'small' }, 'Ver tudo')),
            h('div', { class: 'list' }, ...recent.map((e) => this.historyItem(e))),
          )
        : null,
    ].filter(Boolean) as Node[];
  }

  /** Atualiza só os indicadores online/offline (sem recriar a tela e perder o que foi digitado). */
  private updatePresence(): void {
    for (const el of this.content.querySelectorAll<HTMLElement>('[data-host]')) {
      const online = this.presence[el.dataset.host!];
      if (online === undefined) continue;
      el.querySelector('.dot')?.setAttribute('class', 'dot ' + (online ? 'online' : 'offline'));
      const st = el.querySelector('.presence-text');
      if (st) st.textContent = online ? 'online' : 'offline';
    }
  }

  private favoriteMenu(hostId: string): void {
    const f = store.favorites().find((x) => x.hostId === hostId);
    if (!f) return;
    const name = h('input', { class: 'input', value: f.name, maxlength: 64 }) as HTMLInputElement;
    const sheet = openSheet(f.name, [
      field('Nome', name),
      h(
        'div',
        { class: 'row-actions wrap' },
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              store.saveFavorite({ ...f, name: name.value.trim() || f.name });
              sheet.close();
              this.render();
            },
          },
          'Salvar nome',
        ),
        store.savedKey(hostId)
          ? h(
              'button',
              {
                class: 'btn',
                onclick: () => {
                  store.forgetKey(hostId);
                  toast('Senha esquecida neste celular', 'ok');
                  sheet.close();
                },
              },
              'Esquecer senha',
            )
          : null,
        h(
          'button',
          {
            class: 'btn danger',
            onclick: async () => {
              if (!(await confirmDialog('Remover', `Remover ${f.name} da lista?`, { ok: 'Remover', danger: true }))) return;
              store.removeFavorite(hostId);
              store.forgetKey(hostId);
              sheet.close();
              this.render();
            },
          },
          'Remover',
        ),
      ),
    ]);
  }

  // =========================================================================================
  // Conexão
  // =========================================================================================
  async connect(hostId: string): Promise<void> {
    if (this.session) return;
    let identity;
    try {
      identity = await ensureIdentity();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error', 6000);
      return;
    }
    const conn = new RemoteConnection(this.sig, identity);
    const view = new SessionView(conn, hostId, (reconnect) => {
      this.session = null;
      document.body.classList.remove('in-session');
      this.render();
      if (reconnect) setTimeout(() => void this.connect(hostId), 100);
    });
    this.session = view;
    document.body.classList.add('in-session');
    this.root.append(view.el);
    void conn.start(hostId);
  }

  // =========================================================================================
  // Dispositivos
  // =========================================================================================
  private pageDevices(): Node[] {
    const id = store.identity();
    const s = store.settings();
    const account = store.account();
    const devicesBox = h('div', { class: 'list' }, h('p', { class: 'muted small' }, account ? 'Carregando…' : 'Entre na sua conta para ver todos os seus computadores e celulares.'));
    if (account) {
      api
        .myDevices()
        .then(({ devices }) => {
          clear(devicesBox);
          if (!devices.length) devicesBox.append(h('p', { class: 'muted small' }, 'Nenhum dispositivo vinculado à conta.'));
          for (const d of devices) {
            devicesBox.append(
              h(
                'div',
                { class: 'host-item' },
                h(
                  'button',
                  { class: 'host-main', disabled: d.kind !== 'host', onclick: () => void this.connect(d.id) },
                  h('span', { class: 'host-icon' }, d.kind === 'host' ? '🖥' : '📱'),
                  h('span', { class: 'host-text' }, h('strong', null, d.name), h('small', null, `${formatDeviceId(d.id)} • ${d.online ? 'online' : 'offline'}`)),
                  h('span', { class: 'dot ' + (d.online ? 'online' : 'offline') }),
                ),
                h(
                  'button',
                  {
                    class: 'icon-btn',
                    'aria-label': 'Revogar',
                    onclick: async () => {
                      if (!(await confirmDialog('Revogar dispositivo', `Revogar "${d.name}"? Ele deixará de funcionar com esta conta até ser registrado de novo.`, { ok: 'Revogar', danger: true }))) return;
                      try {
                        await api.revokeDevice(d.id);
                        toast('Dispositivo revogado', 'ok');
                        this.render();
                      } catch (e) {
                        toast((e as Error).message, 'error');
                      }
                    },
                  },
                  '✕',
                ),
              ),
            );
          }
        })
        .catch((e) => {
          clear(devicesBox);
          devicesBox.append(h('p', { class: 'alert error' }, (e as Error).message));
        });
    }
    const pins = store.pins();
    return [
      this.header('Dispositivos'),
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Este celular'),
        h('div', { class: 'kv' }, h('span', null, 'Nome'), h('strong', null, s.deviceName)),
        h('div', { class: 'kv' }, h('span', null, 'ID'), h('strong', { 'data-testid': 'my-id' }, id ? formatDeviceId(id.deviceId) : 'não registrado')),
        h('div', { class: 'kv' }, h('span', null, 'Impressão digital'), h('code', null, id ? keyFingerprint(id.publicKey) : '—')),
        h('p', { class: 'small muted' }, 'O computador mostra esta impressão digital ao pedir aprovação. Confira se é a mesma.'),
      ),
      this.accountCard(),
      h('section', { class: 'card' }, h('h2', null, 'Meus dispositivos (conta)'), devicesBox),
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Computadores verificados'),
        h('p', { class: 'small muted' }, 'Chaves dos computadores já acessados. Se a chave mudar, o app avisa antes de conectar.'),
        ...(pins.length
          ? pins.map((p) =>
              h(
                'div',
                { class: 'host-item' },
                h('div', { class: 'host-main static' }, h('span', { class: 'host-icon' }, '🔑'), h('span', { class: 'host-text' }, h('strong', null, formatDeviceId(p.hostId)), h('small', null, `${p.fingerprint}${p.trustedUnattended ? ' • acesso não assistido' : ''}`))),
                h(
                  'button',
                  {
                    class: 'icon-btn',
                    'aria-label': 'Esquecer',
                    onclick: async () => {
                      if (!(await confirmDialog('Esquecer computador', 'Remover a chave verificada e a senha lembrada deste computador?', { ok: 'Esquecer', danger: true }))) return;
                      store.removePin(p.hostId);
                      store.forgetKey(p.hostId);
                      this.render();
                    },
                  },
                  '✕',
                ),
              ),
            )
          : [h('p', { class: 'small muted' }, 'Nenhum ainda.')]),
      ),
    ];
  }

  private accountCard(): HTMLElement {
    const acc = store.account();
    if (acc) {
      return h(
        'section',
        { class: 'card' },
        h('h2', null, 'Conta'),
        h('div', { class: 'kv' }, h('span', null, 'Usuário'), h('strong', null, `${acc.name} (${acc.email})`)),
        acc.role === 'admin' ? h('div', { class: 'kv' }, h('span', null, 'Perfil'), h('strong', null, 'Administrador')) : null,
        h(
          'div',
          { class: 'row-actions wrap' },
          h('button', { class: 'btn', onclick: async () => api.claimThisDevice().then(() => (toast('Celular vinculado à conta', 'ok'), this.render())).catch((e) => toast(e.message, 'error')) }, 'Vincular este celular'),
          acc.role === 'admin' ? h('button', { class: 'btn', onclick: () => this.openUsers() }, 'Gerenciar usuários') : null,
          h('button', { class: 'btn ghost', onclick: async () => (await api.logout(), this.render()) }, 'Sair'),
        ),
      );
    }
    const email = h('input', { class: 'input', type: 'email', placeholder: 'E-mail', autocomplete: 'email' }) as HTMLInputElement;
    const name = h('input', { class: 'input', placeholder: 'Seu nome (para criar conta)' }) as HTMLInputElement;
    const pw = h('input', { class: 'input', type: 'password', placeholder: 'Senha (mín. 8)', autocomplete: 'current-password' }) as HTMLInputElement;
    const run = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        toast('Conta conectada', 'ok');
        this.render();
      } catch (e) {
        toast((e as Error).message, 'error', 5000);
      }
    };
    return h(
      'section',
      { class: 'card' },
      h('h2', null, 'Conta (opcional)'),
      h('p', { class: 'small muted' }, 'Com uma conta, seus computadores aparecem com status online em qualquer celular.'),
      h('div', { class: 'form' }, email, pw, name),
      h(
        'div',
        { class: 'row-actions' },
        h('button', { class: 'btn primary', onclick: () => run(() => api.login(email.value, pw.value)) }, 'Entrar'),
        h('button', { class: 'btn', onclick: () => run(() => api.register(email.value, name.value || email.value.split('@')[0], pw.value)) }, 'Criar conta'),
      ),
    );
  }

  private openUsers(): void {
    const body = h('div', { class: 'list' }, h('p', { class: 'muted' }, 'Carregando…'));
    openSheet('Usuários', body, { wide: true });
    const load = () =>
      api
        .adminUsers()
        .then(({ users }) => {
          clear(body);
          for (const u of users) {
            body.append(
              h(
                'div',
                { class: 'host-item' },
                h('div', { class: 'host-main static' }, h('span', { class: 'host-text' }, h('strong', null, `${u.name}${u.role === 'admin' ? ' • admin' : ''}`), h('small', null, `${u.email}${u.disabled ? ' • desativado' : ''}`))),
                h('button', { class: 'btn small', onclick: () => api.adminUpdateUser(u.id, { disabled: !u.disabled }).then(load).catch((e) => toast(e.message, 'error')) }, u.disabled ? 'Ativar' : 'Desativar'),
              ),
            );
          }
        })
        .catch((e) => {
          clear(body);
          body.append(h('p', { class: 'alert error' }, e.message));
        });
    void load();
  }

  // =========================================================================================
  // Histórico
  // =========================================================================================
  private historyItem(e: ReturnType<typeof store.history>[number]): HTMLElement {
    const dur = e.endedAt && e.result === 'connected' ? Math.round((new Date(e.endedAt).getTime() - new Date(e.startedAt).getTime()) / 1000) : null;
    const label = { connected: 'Conectado', failed: 'Falhou', rejected: 'Recusado', cancelled: 'Cancelado' }[e.result];
    return h(
      'button',
      { class: 'list-item', onclick: () => void this.connect(e.hostId) },
      h('span', null, h('strong', null, e.hostName), ' ', h('span', { class: `badge ${e.result}` }, label)),
      h('small', null, `${new Date(e.startedAt).toLocaleString('pt-BR')}${dur !== null ? ` • ${Math.floor(dur / 60)} min ${dur % 60} s` : ''}${e.reason ? ` • ${e.reason}` : ''}`),
    );
  }

  private pageHistory(): Node[] {
    const list = store.history();
    const serverBox = h('div', { class: 'list' });
    api
      .mySessions()
      .then(({ sessions }) => {
        if (!sessions.length) return;
        serverBox.append(
          h('h4', null, 'Registro do servidor'),
          ...sessions.slice(0, 30).map((s) => h('div', { class: 'list-item static' }, h('span', null, `${s.hostName} — ${s.status}`), h('small', null, `${new Date(s.createdAt).toLocaleString('pt-BR')}${s.durationSec !== null ? ` • ${Math.round(s.durationSec / 60)} min` : ''}`))),
        );
      })
      .catch(() => undefined);
    return [
      this.header('Histórico'),
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, 'Sessões'), list.length ? h('button', { class: 'btn ghost small', onclick: async () => (await confirmDialog('Limpar histórico', 'Apagar o histórico deste celular?', { ok: 'Apagar', danger: true })) && (store.clearHistory(), this.render()) }, 'Limpar') : null),
        list.length ? h('div', { class: 'list' }, ...list.map((e) => this.historyItem(e))) : h('p', { class: 'muted small' }, 'Nenhuma sessão ainda.'),
      ),
      h('section', { class: 'card' }, serverBox),
    ];
  }

  // =========================================================================================
  // Ajustes
  // =========================================================================================
  private pageSettings(): Node[] {
    const s = store.settings();
    const server = h('input', { class: 'input', value: s.serverUrl, inputmode: 'url', 'data-testid': 'server-input' }) as HTMLInputElement;
    const name = h('input', { class: 'input', value: s.deviceName, maxlength: 64 }) as HTMLInputElement;
    const serverMsg = h('div', { class: 'small' });
    return [
      this.header('Ajustes'),
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Servidor'),
        field('Endereço do servidor RemoteX', server, 'Ex.: https://remotex.suaempresa.com.br ou http://192.168.0.10:8080 na rede local'),
        h(
          'div',
          { class: 'row-actions' },
          h(
            'button',
            {
              class: 'btn primary',
              'data-testid': 'server-save',
              onclick: async () => {
                let url: URL;
                try {
                  url = new URL(server.value.trim());
                } catch {
                  serverMsg.textContent = 'Endereço inválido';
                  return;
                }
                store.saveSettings({ serverUrl: url.origin });
                try {
                  const hc = await api.health();
                  serverMsg.textContent = `Servidor OK (versão ${hc.version})`;
                  this.sig.close();
                  await ensureIdentity();
                  await this.sig.open();
                  this.identityError = '';
                } catch (e) {
                  serverMsg.textContent = (e as Error).message;
                }
              },
            },
            'Salvar e testar',
          ),
        ),
        serverMsg,
      ),
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Este celular'),
        field('Nome exibido no computador', name),
        h('button', { class: 'btn', onclick: async () => (store.saveSettings({ deviceName: name.value.trim() || s.deviceName }), await api.updateDevice({ name: name.value.trim() }).catch(() => undefined), toast('Nome salvo', 'ok')) }, 'Salvar nome'),
      ),
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Controle e visualização'),
        h('div', { class: 'field-label' }, 'Modo de controle padrão'),
        segmented<ControlMode>(
          [
            ['touch', 'Touch'],
            ['mouse', 'Mouse (touchpad)'],
          ],
          s.controlMode,
          (v) => store.saveSettings({ controlMode: v }),
        ),
        h('div', { class: 'field-label' }, 'Visualização padrão'),
        segmented(
          [
            ['fit', 'Tela completa'],
            ['original', 'Resolução original'],
          ],
          s.viewMode,
          (v) => store.saveSettings({ viewMode: v }),
        ),
        h('div', { class: 'field-label' }, 'Qualidade padrão'),
        segmented(
          [
            ['auto', 'Automática'],
            ['high', 'Alta'],
            ['balanced', 'Equilibrada'],
            ['economy', 'Econômica'],
          ],
          s.quality,
          (v) => store.saveSettings({ quality: v }),
        ),
        h('div', { class: 'field-label' }, 'Orientação durante a sessão'),
        segmented(
          [
            ['auto', 'Automática'],
            ['landscape', 'Paisagem'],
            ['portrait', 'Retrato'],
          ],
          s.orientation,
          (v) => store.saveSettings({ orientation: v }),
        ),
        switchRow('Abrir teclado ao tocar em campos de texto', s.autoKeyboard, (v) => store.saveSettings({ autoKeyboard: v }), 'Quando o computador informa um campo de texto ativo (Windows).'),
        switchRow('Inverter rolagem', s.invertScroll, (v) => store.saveSettings({ invertScroll: v })),
        switchRow('Vibração ao clicar', s.haptics, (v) => store.saveSettings({ haptics: v })),
        switchRow('Manter tela ligada durante a sessão', s.keepScreenOn, (v) => store.saveSettings({ keepScreenOn: v })),
        switchRow('Ativar áudio ao conectar', s.audioOnConnect, (v) => store.saveSettings({ audioOnConnect: v })),
      ),
      h('section', { class: 'card' }, h('h2', null, 'Sobre'), h('div', { class: 'kv' }, h('span', null, 'Versão'), h('strong', null, APP_VERSION)), h('div', { class: 'kv' }, h('span', null, 'Plataforma'), h('strong', null, isNativeApp ? 'Aplicativo Android' : 'Navegador'))),
    ];
  }
}
