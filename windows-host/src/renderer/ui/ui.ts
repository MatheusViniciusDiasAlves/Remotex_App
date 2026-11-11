/**
 * Interface do RemoteX Host. Uma única página com três visões:
 *  - view=main      → painel do computador (ID, status, segurança, dispositivos, histórico...)
 *  - view=approval  → janela de aprovação de pedido de acesso
 *  - view=banner    → faixa sempre visível de sessão remota ativa
 */
import type { HostApi, HostStateView, RecordingFile } from '../../shared/ui-ipc';
import { PERMISSION_KEYS, PERMISSION_LABELS, intersect, type PermissionKey, type PermissionSet } from '@remotex/security/permissions';
import { formatDeviceId } from '@remotex/shared/ids';
import { clear, formatBytes, formatDate, formatDuration, h, toggle } from './dom';

declare global {
  interface Window {
    remotex: HostApi;
  }
}

const api = window.remotex;
const params = new URLSearchParams(location.search);
const view = params.get('view') || 'main';
let state: HostStateView | null = null;
let page = localStorage.getItem('rx.page') || 'home';
const root = document.getElementById('app')!;

const STATUS_LABEL: Record<HostStateView['status'], string> = {
  online: 'Online',
  connecting: 'Conectando…',
  offline: 'Offline',
  unauthorized: 'Não autorizado',
  registering: 'Registrando…',
  error: 'Erro',
};

const METHOD_LABEL: Record<string, string> = { password: 'Senha', device: 'Dispositivo confiável', approval: 'Aprovação manual' };
const RESULT_LABEL: Record<string, string> = {
  connected: 'Conectado',
  rejected: 'Recusado',
  failed: 'Falhou',
  timeout: 'Sem resposta',
  cancelled: 'Cancelado',
};
const PATH_LABEL: Record<string, string> = { 'direct-lan': 'Direta (rede local)', 'direct-internet': 'Direta (internet)', relay: 'Via servidor TURN', unknown: '—' };

function permChecks(current: PermissionSet, policy: PermissionSet | null, onChange: (p: PermissionSet) => void, prefix: string) {
  const wrap = h('div', { class: 'perm-grid' });
  for (const k of PERMISSION_KEYS) {
    if (k === 'view') continue;
    const allowed = policy ? policy[k] : true;
    const input = h('input', { type: 'checkbox', checked: current[k] && allowed, disabled: !allowed, 'data-testid': `${prefix}-${k}` });
    input.addEventListener('change', () => onChange({ ...current, [k]: input.checked }));
    wrap.append(
      h('label', { class: 'perm' + (allowed ? '' : ' disabled'), title: allowed ? '' : 'Bloqueado pela política do computador' }, input, h('span', null, PERMISSION_LABELS[k as PermissionKey])),
    );
  }
  return wrap;
}

function chips(p: PermissionSet) {
  return h('div', { class: 'chips' }, ...PERMISSION_KEYS.filter((k) => p[k]).map((k) => h('span', { class: 'chip' }, PERMISSION_LABELS[k])));
}

function card(title: string, ...children: Array<Node | string | null | false>) {
  return h('section', { class: 'card' }, h('h2', null, title), ...children);
}

function row(label: string, control: Node, help?: string) {
  return h('div', { class: 'row' }, h('div', { class: 'row-text' }, h('div', { class: 'row-label' }, label), help ? h('div', { class: 'row-help' }, help) : null), control);
}

// =============================================================================================
// Painel principal
// =============================================================================================
const NAV: Array<[string, string, string]> = [
  ['home', 'Início', '⌂'],
  ['security', 'Segurança e acesso', '🔒'],
  ['devices', 'Dispositivos confiáveis', '📱'],
  ['history', 'Histórico', '🕘'],
  ['recordings', 'Gravações', '⏺'],
  ['settings', 'Configurações', '⚙'],
];

let lastSignature = '';
function renderMain(force = false): void {
  if (!state) return;
  const s = state;
  // Fora da página inicial, ignora atualizações que só mudam estatísticas da sessão.
  const signature = JSON.stringify({ ...s, session: s.session ? { ...s.session, stats: null } : null, page });
  if (!force && page !== 'home' && signature === lastSignature) return;
  lastSignature = signature;
  const active = document.activeElement as HTMLElement | null;
  const keepFocus = active?.dataset?.keep;
  const kept = new Map<string, string>();
  root.querySelectorAll<HTMLInputElement>('input[data-keep]').forEach((i) => kept.set(i.dataset.keep!, i.value));
  clear(root);
  const nav = h(
    'nav',
    { class: 'sidebar' },
    h('div', { class: 'brand' }, h('div', { class: 'logo' }, 'R'), h('div', null, h('div', { class: 'brand-name' }, 'RemoteX'), h('div', { class: 'brand-sub' }, 'Host'))),
    ...NAV.map(([id, label, icon]) =>
      h(
        'button',
        {
          class: 'nav-item' + (page === id ? ' active' : ''),
          'data-testid': `nav-${id}`,
          onclick: () => {
            page = id;
            localStorage.setItem('rx.page', id);
            renderMain(true);
          },
        },
        h('span', { class: 'nav-icon' }, icon),
        label,
        id === 'home' && s.session ? h('span', { class: 'dot live' }) : null,
      ),
    ),
    h(
      'div',
      { class: 'sidebar-foot' },
      h('span', { class: `status-pill ${s.status}`, 'data-testid': 'host-status' }, STATUS_LABEL[s.status]),
      h('div', { class: 'muted small' }, `v${s.version} • ${s.platform === 'win32' ? 'Windows' : s.platform}`),
    ),
  );
  const content = h('main', { class: 'content' });
  const pages: Record<string, () => Node[]> = { home: pageHome, security: pageSecurity, devices: pageDevices, history: pageHistory, recordings: pageRecordings, settings: pageSettings };
  content.append(...(pages[page] || pageHome)());
  root.append(h('div', { class: 'layout' }, nav, content));
  root.querySelectorAll<HTMLInputElement>('input[data-keep]').forEach((i) => {
    if (kept.has(i.dataset.keep!)) i.value = kept.get(i.dataset.keep!)!;
  });
  if (keepFocus) root.querySelector<HTMLElement>(`[data-keep="${keepFocus}"]`)?.focus();
}

function pageHome(): Node[] {
  const s = state!;
  const out: Node[] = [h('h1', null, 'Início')];
  out.push(
    card(
      'Este computador',
      h(
        'div',
        { class: 'id-block' },
        h('div', { class: 'muted' }, 'ID RemoteX'),
        h('div', { class: 'big-id', 'data-testid': 'host-id' }, s.deviceId ? formatDeviceId(s.deviceId) : '— — —'),
        h('button', { class: 'btn ghost', onclick: () => api.copyId() }, 'Copiar ID'),
      ),
      h('div', { class: 'kv' }, h('span', null, 'Nome'), h('strong', null, s.deviceName)),
      h('div', { class: 'kv' }, h('span', null, 'Servidor'), h('strong', null, s.serverUrl)),
      h('div', { class: 'kv' }, h('span', null, 'Impressão digital'), h('code', null, s.hostFingerprint)),
      s.statusMessage ? h('div', { class: 'alert warn' }, s.statusMessage) : null,
    ),
  );
  out.push(
    card(
      'Conexões remotas',
      row(
        'Permitir conexões remotas',
        toggle(s.incomingEnabled, (v) => api.setIncoming(v), 'toggle-incoming'),
        s.incomingEnabled ? 'Este computador aceita pedidos de acesso conforme as regras de segurança.' : 'Nenhum dispositivo consegue se conectar enquanto estiver desativado.',
      ),
      h(
        'div',
        { class: 'chips' },
        h('span', { class: 'chip ' + (s.attendedEnabled ? 'ok' : '') }, `Aprovação manual: ${s.attendedEnabled ? 'ativada' : 'desativada'}`),
        h('span', { class: 'chip ' + (s.unattendedEnabled ? 'ok' : '') }, `Acesso não assistido: ${s.unattendedEnabled ? 'ativado' : 'desativado'}`),
        h('span', { class: 'chip ' + (s.hasPassword ? 'ok' : '') }, `Senha: ${s.hasPassword ? 'definida' : 'não definida'}`),
        h('span', { class: 'chip' }, `${s.trusted.length} dispositivo(s) confiável(is)`),
      ),
    ),
  );
  if (s.session) {
    const ss = s.session;
    out.push(
      h(
        'section',
        { class: 'card session', 'data-testid': 'session-card' },
        h('h2', null, h('span', { class: 'dot live' }), ' Sessão ativa'),
        h('div', { class: 'kv' }, h('span', null, 'Dispositivo'), h('strong', null, `${ss.clientName} (${formatDeviceId(ss.clientId)})`)),
        h('div', { class: 'kv' }, h('span', null, 'Impressão digital'), h('code', null, ss.clientFingerprint)),
        h('div', { class: 'kv' }, h('span', null, 'Autorização'), h('strong', null, METHOD_LABEL[ss.method] || ss.method)),
        h('div', { class: 'kv' }, h('span', null, 'Estado'), h('strong', { 'data-testid': 'session-state' }, ss.verified ? 'Conectado e verificado' : ss.connected ? 'Verificando canal…' : 'Conectando…')),
        h('div', { class: 'kv' }, h('span', null, 'Duração'), h('strong', { class: 'live-duration', dataset: { start: String(ss.startedAt) } }, formatDuration(Date.now() - ss.startedAt))),
        ss.sas ? h('div', { class: 'kv' }, h('span', null, 'Código de verificação'), h('strong', { class: 'sas', 'data-testid': 'session-sas' }, ss.sas)) : null,
        ss.stats
          ? h(
              'div',
              { class: 'stats' },
              h('span', null, `${ss.stats.width}×${ss.stats.height}`),
              h('span', null, `${ss.stats.fps} fps`),
              h('span', null, `${(ss.stats.kbps / 1000).toFixed(1)} Mbps`),
              h('span', null, ss.stats.rttMs !== null ? `${ss.stats.rttMs} ms` : '— ms'),
              h('span', null, `${ss.stats.codec || '—'}${ss.stats.encoder ? ` (${ss.stats.encoder})` : ''}`),
              h('span', null, PATH_LABEL[ss.stats.path] || ss.stats.path),
            )
          : null,
        chips(ss.permissions),
        ss.recording ? h('div', { class: 'alert rec' }, `● Gravando (${ss.recording.target === 'host' ? 'neste computador' : 'no celular'}) — ${ss.recording.state}`) : null,
        h(
          'div',
          { class: 'actions' },
          ss.recording ? h('button', { class: 'btn', onclick: () => api.stopRecording() }, 'Parar gravação') : null,
          h('button', { class: 'btn danger', 'data-testid': 'end-session', onclick: () => api.endSession() }, 'Encerrar sessão'),
        ),
      ),
    );
  }
  if (s.platform === 'win32') {
    out.push(
      card(
        'Privilégios',
        s.elevated
          ? h('div', { class: 'alert ok' }, 'O RemoteX está executando como administrador: janelas elevadas podem ser controladas.')
          : h(
              'div',
              null,
              h('p', { class: 'muted' }, 'Sem privilégios de administrador, o Windows impede o controle de janelas de programas elevados (UIPI). Reinicie como administrador para controlá-las — o Windows pedirá confirmação (UAC).'),
              h('button', { class: 'btn', onclick: async () => alert((await api.relaunchElevated()).message) }, 'Reiniciar como administrador'),
            ),
      ),
    );
  }
  return out;
}

let pwMsg = { text: '', cls: '' };
function pageSecurity(): Node[] {
  const s = state!;
  const msg = h('div', { class: 'form-msg ' + pwMsg.cls, 'data-testid': 'pw-msg' }, pwMsg.text);
  const pw1 = h('input', { type: 'password', placeholder: 'Nova senha (mín. 8 caracteres)', autocomplete: 'new-password', 'data-testid': 'pw-new', dataset: { keep: 'pw1' } });
  const pw2 = h('input', { type: 'password', placeholder: 'Confirme a senha', autocomplete: 'new-password', 'data-testid': 'pw-confirm', dataset: { keep: 'pw2' } });
  const save = async () => {
    const a = pw1.value;
    const b = pw2.value;
    if (a !== b) {
      pwMsg = { text: 'As senhas não conferem.', cls: 'err' };
      return renderMain(true);
    }
    const err = await api.setPassword(a);
    pwMsg = { text: err || 'Senha salva.', cls: err ? 'err' : 'ok' };
    if (!err) root.querySelectorAll<HTMLInputElement>('input[type=password]').forEach((i) => (i.value = ''));
    renderMain(true);
  };
  return [
    h('h1', null, 'Segurança e acesso'),
    card(
      'Aprovação manual',
      row('Aceitar pedidos com aprovação', toggle(s.attendedEnabled, (v) => api.setAttended(v), 'toggle-attended'), 'Uma janela pergunta a quem está no computador se o acesso deve ser liberado.'),
      row(
        'Tempo para responder',
        (() => {
          const sel = h('select', null, ...[30, 60, 120, 300].map((v) => h('option', { value: String(v), selected: s.approvalTimeoutSec === v }, `${v} s`)));
          sel.addEventListener('change', () => api.setApprovalTimeout(Number(sel.value)));
          return sel;
        })(),
      ),
    ),
    card(
      'Acesso não assistido',
      row(
        'Permitir acesso não assistido',
        toggle(s.unattendedEnabled, (v) => api.setUnattended(v), 'toggle-unattended'),
        'Permite conectar sem ninguém no computador: com a senha de acesso ou a partir de dispositivos confiáveis autorizados previamente.',
      ),
      h('div', { class: 'kv' }, h('span', null, 'Senha de acesso'), h('strong', { 'data-testid': 'pw-status' }, s.hasPassword ? 'Definida' : 'Não definida')),
      s.passwordLockedForMs > 0 ? h('div', { class: 'alert warn' }, `Senha bloqueada por excesso de tentativas por mais ${Math.ceil(s.passwordLockedForMs / 1000)} s.`) : null,
      h('div', { class: 'form' }, pw1, pw2, h('div', { class: 'actions' }, h('button', { class: 'btn primary', 'data-testid': 'pw-save', onclick: save }, 'Salvar senha'), s.hasPassword ? h('button', { class: 'btn danger', onclick: () => api.setPassword(null) }, 'Remover senha') : null), msg),
      h('h3', null, 'Permissões para acesso por senha'),
      permChecks(s.passwordPermissions, s.policy, (p) => api.setPasswordPermissions(p), 'pwperm'),
    ),
    card('Funções permitidas remotamente', h('p', { class: 'muted' }, 'Limite máximo para qualquer sessão, mesmo de dispositivos confiáveis.'), permChecks(s.policy, null, (p) => api.setPolicy(p), 'policy')),
  ];
}

function pageDevices(): Node[] {
  const s = state!;
  if (s.trusted.length === 0) {
    return [h('h1', null, 'Dispositivos confiáveis'), card('Nenhum dispositivo', h('p', { class: 'muted' }, 'Ao aprovar um pedido, marque "Confiar neste dispositivo" para que ele apareça aqui.'))];
  }
  return [
    h('h1', null, 'Dispositivos confiáveis'),
    ...s.trusted.map((t) =>
      h(
        'section',
        { class: 'card device', 'data-testid': 'trusted-device' },
        h('div', { class: 'device-head' }, h('div', null, h('h2', null, t.name), h('div', { class: 'muted small' }, `ID ${formatDeviceId(t.deviceId)} • ${t.fingerprint}`)), h('button', { class: 'btn danger', onclick: () => confirm(`Revogar ${t.name}?`) && api.revokeTrusted(t.fingerprint) }, 'Revogar')),
        h('div', { class: 'muted small' }, `Adicionado em ${formatDate(t.addedAt)} • último acesso ${formatDate(t.lastSeenAt)}`),
        row('Acesso não assistido (sem confirmação)', toggle(t.unattended, (v) => api.updateTrusted(t.fingerprint, { unattended: v }))),
        permChecks(t.permissions, s.policy, (p) => api.updateTrusted(t.fingerprint, { permissions: p }), `dev-${t.fingerprint}`),
      ),
    ),
  ];
}

function pageHistory(): Node[] {
  const s = state!;
  const table = h(
    'table',
    { class: 'table' },
    h('thead', null, h('tr', null, ...['Data', 'Dispositivo', 'Método', 'Resultado', 'Duração', 'IP', 'Detalhe'].map((x) => h('th', null, x)))),
    h(
      'tbody',
      null,
      ...s.history.map((e) =>
        h(
          'tr',
          null,
          h('td', null, formatDate(e.requestedAt)),
          h('td', null, `${e.clientName} (${formatDeviceId(e.clientId)})`),
          h('td', null, e.method ? METHOD_LABEL[e.method] || e.method : '—'),
          h('td', null, h('span', { class: `badge ${e.result}` }, RESULT_LABEL[e.result] || e.result)),
          h('td', null, e.startedAt && e.endedAt ? formatDuration(new Date(e.endedAt).getTime() - new Date(e.startedAt).getTime()) : '—'),
          h('td', null, e.ip || '—'),
          h('td', { class: 'muted' }, e.reason || ''),
        ),
      ),
    ),
  );
  return [
    h('h1', null, 'Histórico de conexões'),
    card('Últimas conexões', s.history.length ? table : h('p', { class: 'muted' }, 'Nenhuma conexão registrada.'), s.history.length ? h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => confirm('Limpar o histórico local?') && api.clearHistory() }, 'Limpar histórico')) : null),
  ];
}

let recordingsCache: RecordingFile[] | null = null;
function pageRecordings(): Node[] {
  const s = state!;
  const list = h('div', { class: 'rec-list' }, h('p', { class: 'muted' }, 'Carregando…'));
  const load = async () => {
    recordingsCache = await api.listRecordings();
    clear(list);
    if (!recordingsCache.length) list.append(h('p', { class: 'muted' }, 'Nenhuma gravação ainda.'));
    for (const r of recordingsCache) {
      list.append(
        h(
          'div',
          { class: 'rec-item' },
          h('div', null, h('strong', null, r.name), h('div', { class: 'muted small' }, `${formatBytes(r.size)} • ${formatDate(r.createdAt)}`)),
          h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => api.openRecording(r.name) }, 'Abrir'), h('button', { class: 'btn danger', onclick: async () => confirm(`Excluir ${r.name}?`) && (await api.deleteRecording(r.name), load()) }, 'Excluir')),
        ),
      );
    }
  };
  void load();
  const q = h('select', null, ...(['low', 'medium', 'high'] as const).map((v) => h('option', { value: v, selected: s.recording.quality === v }, { low: 'Baixa (1 Mbps)', medium: 'Média (3 Mbps)', high: 'Alta (8 Mbps)' }[v])));
  q.addEventListener('change', () => api.setRecording({ quality: q.value as any }));
  return [
    h('h1', null, 'Gravações'),
    card(
      'Configuração',
      h('p', { class: 'muted' }, 'Gravações só acontecem quando o dispositivo tem a permissão "Gravar a sessão". Um indicador vermelho aparece no computador e no celular durante toda a gravação.'),
      row('Pasta', h('div', { class: 'actions' }, h('code', null, s.recording.dir), h('button', { class: 'btn ghost', onclick: () => api.chooseRecordingDir() }, 'Alterar'), h('button', { class: 'btn ghost', onclick: () => api.showRecordingsFolder() }, 'Abrir pasta'))),
      row('Qualidade padrão', q),
    ),
    card('Arquivos', list),
  ];
}

function pageSettings(): Node[] {
  const s = state!;
  const name = h('input', { value: s.deviceName, maxlength: 64, dataset: { keep: 'name' } });
  const server = h('input', { value: s.serverUrl, dataset: { keep: 'server' }, 'data-testid': 'server-url' });
  const serverMsg = h('div', { class: 'form-msg' });
  const sel = <T extends string>(value: T, opts: Array<[T, string]>, onChange: (v: T) => void) => {
    const el = h('select', null, ...opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
    el.addEventListener('change', () => onChange(el.value as T));
    return el;
  };
  return [
    h('h1', null, 'Configurações'),
    card(
      'Identificação',
      row('Nome do computador', h('div', { class: 'actions' }, name, h('button', { class: 'btn', onclick: () => api.setDeviceName(name.value) }, 'Salvar'))),
      row(
        'Servidor RemoteX',
        h(
          'div',
          { class: 'actions' },
          server,
          h(
            'button',
            {
              class: 'btn',
              onclick: async () => {
                const err = await api.setServerUrl(server.value);
                serverMsg.textContent = err || 'Servidor atualizado e computador registrado.';
                serverMsg.className = 'form-msg ' + (err ? 'err' : 'ok');
              },
            },
            'Salvar',
          ),
        ),
        'Ao trocar de servidor, o computador recebe um novo ID.',
      ),
      serverMsg,
    ),
    card(
      'Vídeo',
      row('Qualidade', sel(s.quality.preset, [['auto', 'Automática (adapta à rede)'], ['high', 'Alta qualidade'], ['balanced', 'Equilibrada'], ['economy', 'Econômica (menos dados)']], (v) => api.setQuality({ ...s.quality, preset: v }))),
      row('Codec preferido', sel(s.quality.codec, [['auto', 'Automático (H.264 com hardware)'], ['h264', 'H.264'], ['vp9', 'VP9'], ['vp8', 'VP8'], ['av1', 'AV1']], (v) => api.setQuality({ ...s.quality, codec: v }))),
    ),
    card(
      'Áudio',
      row('Qualidade do áudio', sel(s.audio.quality, [['low', 'Baixa (32 kbps)'], ['medium', 'Média (64 kbps)'], ['high', 'Alta (128 kbps)']], (v) => api.setAudio({ ...s.audio, quality: v }))),
      row('Transmitir áudio ao conectar', toggle(s.audio.enabledByDefault, (v) => api.setAudio({ ...s.audio, enabledByDefault: v })), s.platform === 'win32' ? 'Som do Windows capturado por loopback.' : 'Captura de áudio do sistema disponível apenas no Windows.'),
    ),
    card(
      'Sistema',
      row('Iniciar com o Windows', toggle(s.launchAtStartup, (v) => api.setLaunchAtStartup(v)), 'Inicia minimizado na bandeja. Desativado por padrão.'),
      row('Continuar em segundo plano ao fechar', toggle(s.runInBackground, (v) => api.setRunInBackground(v)), 'Se desativado, fechar a janela encerra o RemoteX e nenhuma conexão será aceita.'),
    ),
    card('Sobre', h('div', { class: 'kv' }, h('span', null, 'Versão'), h('strong', null, s.version)), h('div', { class: 'kv' }, h('span', null, 'Executando como administrador'), h('strong', null, s.elevated ? 'Sim' : 'Não'))),
  ];
}

// =============================================================================================
// Janela de aprovação
// =============================================================================================
let approvalPerms: PermissionSet | null = null;
let approvalTrust = false;
let approvalUnattended = false;

function renderApproval(): void {
  if (!state) return;
  const sid = params.get('session');
  const req = state.approvals.find((a) => a.sessionId === sid);
  clear(root);
  if (!req) {
    root.append(h('div', { class: 'approval' }, h('p', { class: 'muted' }, 'Este pedido não está mais pendente.')));
    return;
  }
  approvalPerms ??= intersect(req.policy, req.suggested);
  const left = Math.max(0, Math.ceil((req.expiresAt - Date.now()) / 1000));
  const unattended = h('input', { type: 'checkbox', checked: approvalUnattended, disabled: !approvalTrust, 'data-testid': 'approve-unattended' });
  unattended.addEventListener('change', () => (approvalUnattended = unattended.checked));
  const trust = h('input', { type: 'checkbox', checked: approvalTrust, 'data-testid': 'approve-trust' });
  trust.addEventListener('change', () => {
    approvalTrust = trust.checked;
    if (!approvalTrust) approvalUnattended = false;
    renderApproval();
  });
  root.append(
    h(
      'div',
      { class: 'approval' },
      h('div', { class: 'approval-head' }, h('div', { class: 'logo' }, 'R'), h('div', null, h('h1', null, 'Pedido de acesso remoto'), h('div', { class: 'muted' }, `Responda em ${left} s`))),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'requester', 'data-testid': 'approve-name' }, req.clientName),
        h('div', { class: 'kv' }, h('span', null, 'ID do dispositivo'), h('strong', null, formatDeviceId(req.clientId))),
        h('div', { class: 'kv' }, h('span', null, 'Impressão digital'), h('code', null, req.fingerprint)),
        h('div', { class: 'kv' }, h('span', null, 'Endereço IP'), h('strong', null, req.ip || '—')),
        req.account ? h('div', { class: 'kv' }, h('span', null, 'Conta'), h('strong', null, req.account)) : null,
      ),
      h('div', { class: 'alert warn' }, 'Só aceite se você reconhece quem está pedindo. Golpistas costumam se passar por suporte técnico.'),
      h('h3', null, 'Permitir'),
      permChecks(approvalPerms, req.policy, (p) => (approvalPerms = p), 'approve-perm'),
      h('label', { class: 'perm' }, trust, h('span', null, 'Confiar neste dispositivo')),
      h('label', { class: 'perm' + (approvalTrust ? '' : ' disabled') }, unattended, h('span', null, 'Permitir acesso não assistido (sem nova confirmação)')),
      h(
        'div',
        { class: 'actions end' },
        h('button', { class: 'btn danger', 'data-testid': 'approve-reject', onclick: () => api.decide(req.sessionId, { accept: false, permissions: approvalPerms!, trust: false, unattended: false }) }, 'Recusar'),
        h('button', { class: 'btn primary', 'data-testid': 'approve-accept', onclick: () => api.decide(req.sessionId, { accept: true, permissions: approvalPerms!, trust: approvalTrust, unattended: approvalUnattended }) }, 'Aceitar'),
      ),
    ),
  );
}

// =============================================================================================
// Banner de sessão ativa
// =============================================================================================
function renderBanner(): void {
  clear(root);
  const ss = state?.session;
  if (!ss) return;
  root.append(
    h(
      'div',
      { class: 'banner' },
      h('span', { class: 'dot live' }),
      h('div', { class: 'banner-text' }, h('strong', null, `${ss.clientName} está ${ss.permissions.control ? 'controlando' : 'vendo'} este computador`), h('span', { class: 'muted small' }, `${formatDuration(Date.now() - ss.startedAt)}${ss.sas ? ` • código ${ss.sas}` : ''}`)),
      ss.recording ? h('span', { class: 'rec-pill' }, '● REC') : null,
      h('button', { class: 'btn ghost small', onclick: () => api.showMain() }, 'Detalhes'),
      h('button', { class: 'btn danger small', 'data-testid': 'banner-end', onclick: () => api.endSession() }, 'Encerrar'),
    ),
  );
}

function render(): void {
  if (view === 'approval') renderApproval();
  else if (view === 'banner') renderBanner();
  else renderMain();
}

document.body.dataset.view = view;
api.onState((s) => {
  state = s;
  render();
});
void api.getState().then((s) => {
  state = s;
  render();
});
// relógio (duração/contagem regressiva)
setInterval(() => {
  if (view !== 'main') return render();
  for (const el of document.querySelectorAll<HTMLElement>('.live-duration')) el.textContent = formatDuration(Date.now() - Number(el.dataset.start));
}, 1000);
