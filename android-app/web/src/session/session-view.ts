/**
 * Tela de sessão remota: exibe a tela do computador e concentra os controles.
 */
import { clear, h } from '@remotex/shared/dom';
import { formatDeviceId } from '@remotex/shared/ids';
import { qualityBars, type InboundSummary } from '@remotex/media/stats';
import type { DisplayInfo, HostControlMessage, QualityPreset, RecordingState } from '@remotex/media/channel-protocol';
import { PERMISSION_KEYS, PERMISSION_LABELS, type PermissionSet } from '@remotex/security/permissions';
import { SessionRecorder, pickRecordingMime, recordingFileName } from '@remotex/recording/recorder';
import { RemoteConnection, type AuthNeeded, type HostKeyChange, type Phase } from '../core/connection';
import { Viewport } from '../core/viewport';
import { native } from '../core/native';
import { store, type ControlMode, type Settings } from '../core/storage';
import { InputController } from './input-controller';
import { RemoteKeyboard, SHORTCUTS } from './keyboard';
import { closeAllSheets, confirmDialog, openSheet, segmented, switchRow, toast, type Sheet } from '../ui/overlays';

const PHASE_TEXT: Record<Phase, string> = {
  signaling: 'Conectando ao servidor…',
  requesting: 'Localizando o computador…',
  auth: 'Autenticando…',
  'waiting-approval': 'Aguardando aprovação no computador…',
  connecting: 'Estabelecendo conexão segura…',
  verifying: 'Verificando o canal criptografado…',
  connected: 'Conectado',
  ended: 'Sessão encerrada',
};

const PATH_TEXT: Record<string, string> = { 'direct-lan': 'Direta • rede local', 'direct-internet': 'Direta • internet', relay: 'Via servidor TURN', unknown: '—' };

export class SessionView {
  readonly el: HTMLElement;
  private stage: HTMLElement;
  private video: HTMLVideoElement;
  private cursorEl: HTMLElement;
  private overlay: HTMLElement;
  private hud: HTMLElement;
  private toolbar: HTMLElement;
  private mouseBar: HTMLElement;
  private statusChip: HTMLElement;
  private recPill: HTMLElement;
  private viewport = new Viewport();
  private input: InputController;
  private keyboard: RemoteKeyboard;
  private settings: Settings;
  private mode: ControlMode;
  private viewMode: 'fit' | 'original';
  private quality: QualityPreset;
  private displays: DisplayInfo[] = [];
  private activeDisplay = '';
  private audioOn = false;
  private audioAvailable = false;
  private micOn = false;
  private hostRec: RecordingState | null = null;
  private clientRec: { recorder: SessionRecorder; sink: ReturnType<typeof native.recordingSink>; name: string; state: 'recording' | 'paused' } | null = null;
  private lastClip = '';
  private autoClip = true;
  private rpcId = 1;
  private rpcWaiters = new Map<number, (r: { ok: boolean; result?: any; error?: string }) => void>();
  private hideTimer: number | null = null;
  private keyboardInset = 0;
  private immersive = false;
  private resizeObs: ResizeObserver;
  private historyId: string;
  private destroyed = false;

  constructor(
    readonly conn: RemoteConnection,
    readonly hostId: string,
    private readonly onExit: (reconnect: boolean) => void,
  ) {
    this.settings = store.settings();
    this.mode = this.settings.controlMode;
    this.viewMode = this.settings.viewMode;
    this.quality = this.settings.quality;
    this.viewport.dpr = window.devicePixelRatio || 1;
    this.historyId = `${Date.now()}-${hostId}`;

    this.video = h('video', { class: 'remote-video', autoplay: true, playsInline: true, muted: true, 'data-testid': 'remote-video' }) as HTMLVideoElement;
    this.video.setAttribute('playsinline', '');
    this.cursorEl = h('div', { class: 'local-cursor', hidden: true });
    this.stage = h('div', { class: 'stage', 'data-testid': 'stage' }, this.video, this.cursorEl);
    this.overlay = h('div', { class: 'conn-overlay', 'data-testid': 'conn-overlay' });
    this.statusChip = h('button', { class: 'status-chip', 'data-testid': 'status-chip', onclick: () => this.openInfo() }, '…');
    this.recPill = h('div', { class: 'rec-pill', hidden: true, 'data-testid': 'rec-indicator' }, '● REC');
    this.toolbar = h('div', { class: 'toolbar', 'data-testid': 'toolbar' });
    this.hud = h('div', { class: 'hud' }, this.statusChip, this.recPill, h('button', { class: 'hud-handle', 'aria-label': 'Mostrar ferramentas', 'data-testid': 'toolbar-handle', onclick: () => this.showToolbar(true) }, '⋯'));
    this.mouseBar = h('div', { class: 'mouse-bar', hidden: this.mode !== 'mouse' });

    this.keyboard = new RemoteKeyboard({
      conn,
      canType: () => this.canType(),
      onVisibility: (open, barH) => this.onKeyboard(open, barH),
      onShortcuts: () => this.openShortcuts(),
    });

    this.el = h('div', { class: 'session', 'data-testid': 'session' }, this.stage, this.hud, this.toolbar, this.mouseBar, this.keyboard.bar, this.keyboard.input, this.overlay);
    this.renderToolbar();
    this.renderMouseBar();

    this.input = new InputController({
      conn,
      viewport: this.viewport,
      stage: this.stage,
      mode: () => this.mode,
      canControl: () => this.canControl(),
      settings: () => this.settings,
      remoteSize: () => this.remoteSize(),
      onViewportChange: () => this.applyTransform(),
      onCursor: (x, y, active) => this.drawCursor(x, y, active),
      onTap: () => this.showToolbar(false),
      onInteraction: () => undefined,
    });

    this.resizeObs = new ResizeObserver(() => this.layout());
    this.resizeObs.observe(this.stage);
    this.video.addEventListener('loadedmetadata', () => this.onVideoSize());
    this.video.addEventListener('resize', () => this.onVideoSize());
    window.visualViewport?.addEventListener('resize', this.onVisualViewport);
    window.addEventListener('orientationchange', this.onVisualViewport);
    this.wireConnection();
    this.renderOverlay();
  }

  // =========================================================================================
  // Conexão
  // =========================================================================================
  private wireConnection(): void {
    const c = this.conn;
    c.on('phase', () => this.renderOverlay());
    c.on('auth-needed', (a) => this.renderAuth(a));
    c.on('host-key-changed', (k) => this.renderKeyChange(k));
    c.on('stream', (s) => {
      this.video.srcObject = s;
      this.video.play().catch(() => undefined);
    });
    c.on('welcome', (w) => {
      this.displays = w.displays;
      this.activeDisplay = w.activeDisplay;
      this.audioAvailable = w.audioAvailable;
      this.onVideoSize();
      this.renderToolbar();
    });
    c.on('verified', ({ sas }) => {
      this.renderOverlay();
      toast(`Conectado a ${c.hostName}. Código de verificação: ${sas}`, 'ok', 5000);
      void native.keepScreenOn(this.settings.keepScreenOn);
      if (this.settings.orientation !== 'auto') void native.setOrientation(this.settings.orientation);
      if (this.quality !== 'auto' || this.viewMode === 'original') c.sendControl({ k: 'quality', preset: this.quality, original: this.viewMode === 'original' });
      if (this.settings.audioOnConnect && c.permissions?.audio) this.setAudio(true);
      this.saveHistory('connected');
      const fav = store.favorites().find((f) => f.hostId === this.hostId);
      store.saveFavorite({ hostId: this.hostId, name: fav?.name || c.hostName, addedAt: fav?.addedAt ?? new Date().toISOString(), lastConnectedAt: new Date().toISOString() });
      this.showToolbar(true);
    });
    c.on('control', (m) => this.onControl(m));
    c.on('cursor', ({ x, y }) => this.input.setCursorFromHost(x, y));
    c.on('stats', (s) => this.renderStatus(s));
    c.on('ended', ({ reason, error }) => this.onEnded(reason, error));
  }

  private onControl(m: HostControlMessage): void {
    switch (m.k) {
      case 'notice':
        toast(m.message, m.level === 'error' ? 'error' : m.level === 'warn' ? 'warn' : 'info', 6000);
        return;
      case 'clip':
        this.lastClip = m.text;
        if (this.autoClip) void native.setClipboard(m.text);
        return;
      case 'ime':
        if (m.editable && this.settings.autoKeyboard && !this.keyboard.open && this.canType()) this.keyboard.show();
        return;
      case 'rec.state':
        void this.onRecState(m.target, m.state, m.message, m.file);
        return;
      case 'quality.state':
        this.renderToolbar();
        return;
      case 'display':
        this.displays = m.displays;
        this.activeDisplay = m.activeDisplay;
        this.onVideoSize();
        return;
      case 'audio.state':
        this.audioOn = m.enabled;
        this.audioAvailable = m.available;
        this.video.muted = !m.enabled;
        this.renderToolbar();
        return;
      case 'perms':
        this.renderToolbar();
        return;
      case 'rpc.res': {
        const w = this.rpcWaiters.get(m.id);
        this.rpcWaiters.delete(m.id);
        w?.(m);
        return;
      }
    }
  }

  private onEnded(reason: string, error: boolean): void {
    void this.stopClientRecording();
    this.keyboard.hide();
    void native.keepScreenOn(false);
    void native.setImmersive(false);
    void native.setOrientation('auto');
    closeAllSheets();
    if (this.conn.connectedAt) this.saveHistory('connected', reason);
    else this.saveHistory(error ? 'failed' : 'cancelled', reason);
    clear(this.overlay);
    this.overlay.hidden = false;
    this.overlay.append(
      h(
        'div',
        { class: 'conn-card' },
        h('div', { class: 'conn-icon ' + (error ? 'err' : '') }, error ? '!' : '✓'),
        h('h2', null, error ? 'Não foi possível manter a conexão' : 'Sessão encerrada'),
        h('p', { class: 'muted', 'data-testid': 'end-reason' }, reason),
        h(
          'div',
          { class: 'row-actions' },
          h('button', { class: 'btn ghost', onclick: () => this.exit(false) }, 'Voltar'),
          h('button', { class: 'btn primary', onclick: () => this.exit(true) }, 'Reconectar'),
        ),
      ),
    );
  }

  private saveHistory(result: 'connected' | 'failed' | 'rejected' | 'cancelled', reason?: string): void {
    store.saveHistory({
      id: this.historyId,
      hostId: this.hostId,
      hostName: this.conn.hostName || formatDeviceId(this.hostId),
      method: this.conn.method,
      result,
      reason,
      startedAt: new Date(this.conn.connectedAt ?? this.conn.startedAt).toISOString(),
      endedAt: this.conn.phase === 'ended' ? new Date().toISOString() : null,
    });
  }

  // =========================================================================================
  // Sobreposição de conexão (fases, senha, aprovação, alerta de identidade)
  // =========================================================================================
  private renderOverlay(): void {
    const phase = this.conn.phase;
    if (phase === 'connected') {
      this.overlay.hidden = true;
      return;
    }
    if (phase === 'ended' || phase === 'auth') {
      if (phase === 'auth' && this.overlay.querySelector('.auth-form')) return;
      if (phase === 'ended') return;
    }
    this.overlay.hidden = false;
    clear(this.overlay);
    this.overlay.append(
      h(
        'div',
        { class: 'conn-card' },
        h('div', { class: 'spinner' }),
        h('h2', null, this.conn.hostName || `Computador ${formatDeviceId(this.hostId)}`),
        h('p', { class: 'muted', 'data-testid': 'phase-text' }, PHASE_TEXT[phase]),
        phase === 'waiting-approval' ? h('p', { class: 'small muted' }, 'Peça para alguém no computador clicar em "Aceitar".') : null,
        h('div', { class: 'row-actions' }, h('button', { class: 'btn ghost', 'data-testid': 'cancel-connect', onclick: () => this.conn.disconnect('Conexão cancelada') }, 'Cancelar')),
      ),
    );
  }

  private renderAuth(a: AuthNeeded): void {
    this.overlay.hidden = false;
    clear(this.overlay);
    const pw = h('input', { type: 'password', class: 'input', placeholder: 'Senha de acesso', autocomplete: 'current-password', 'data-testid': 'auth-password' }) as HTMLInputElement;
    const remember = h('input', { type: 'checkbox', 'data-testid': 'auth-remember' }) as HTMLInputElement;
    const submit = h('button', { class: 'btn primary', 'data-testid': 'auth-submit' }, 'Conectar') as HTMLButtonElement;
    const go = () => {
      if (!pw.value) return pw.focus();
      submit.disabled = true;
      submit.textContent = 'Verificando…';
      void this.conn.submitPassword(pw.value, remember.checked);
    };
    submit.addEventListener('click', go);
    pw.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    this.overlay.append(
      h(
        'div',
        { class: 'conn-card auth-form' },
        h('h2', null, a.hostName || formatDeviceId(this.hostId)),
        a.error ? h('div', { class: 'alert error', 'data-testid': 'auth-error' }, a.error) : null,
        a.lockedForMs ? h('div', { class: 'alert warn' }, `Senha bloqueada temporariamente (${Math.ceil(a.lockedForMs / 1000)} s).`) : null,
        a.password
          ? h(
              'div',
              { class: 'form' },
              pw,
              h('label', { class: 'check' }, remember, h('span', null, 'Lembrar neste celular')),
              submit,
            )
          : null,
        a.approval ? h('button', { class: 'btn ' + (a.password ? 'ghost' : 'primary'), 'data-testid': 'auth-approval', onclick: () => this.conn.requestApproval() }, 'Pedir aprovação a quem está no computador') : null,
        h('button', { class: 'btn ghost', onclick: () => this.conn.disconnect('Conexão cancelada') }, 'Cancelar'),
      ),
    );
    if (a.password) setTimeout(() => pw.focus(), 50);
  }

  private renderKeyChange(k: HostKeyChange): void {
    this.overlay.hidden = false;
    clear(this.overlay);
    this.overlay.append(
      h(
        'div',
        { class: 'conn-card' },
        h('div', { class: 'conn-icon err' }, '!'),
        h('h2', null, 'A identidade do computador mudou'),
        h('p', null, `A chave de "${k.hostName}" é diferente da usada nas conexões anteriores. Isso acontece se o RemoteX foi reinstalado — mas também pode indicar uma tentativa de interceptação.`),
        h('div', { class: 'kv' }, h('span', null, 'Anterior'), h('code', null, k.oldFingerprint)),
        h('div', { class: 'kv' }, h('span', null, 'Nova'), h('code', null, k.newFingerprint)),
        h(
          'div',
          { class: 'row-actions' },
          h('button', { class: 'btn ghost', onclick: () => this.conn.disconnect('Conexão cancelada por segurança') }, 'Cancelar'),
          h('button', { class: 'btn danger', onclick: () => this.conn.acceptNewHostKey() }, 'Confio na nova identidade'),
        ),
      ),
    );
  }

  // =========================================================================================
  // Vídeo, viewport e cursor
  // =========================================================================================
  private remoteSize(): { width: number; height: number } {
    const d = this.displays.find((x) => x.id === this.activeDisplay);
    return d ? { width: d.width, height: d.height } : { width: this.video.videoWidth || 1920, height: this.video.videoHeight || 1080 };
  }

  private onVideoSize(): void {
    if (!this.video.videoWidth) return;
    this.viewport.setContent(this.video.videoWidth, this.video.videoHeight);
    this.viewport.remoteW = this.remoteSize().width;
    this.video.style.width = `${this.video.videoWidth}px`;
    this.video.style.height = `${this.video.videoHeight}px`;
    this.applyViewMode();
  }

  private layout(): void {
    const r = this.stage.getBoundingClientRect();
    const wasFit = !this.viewport.isZoomed;
    this.viewport.setContainer(r.width, r.height);
    if (wasFit && this.viewMode === 'fit') this.viewport.fit();
    else this.viewport.clamp();
    this.applyTransform();
  }

  private applyViewMode(): void {
    this.layout();
    if (this.viewMode === 'fit') this.viewport.fit();
    else this.viewport.original();
    this.applyTransform();
  }

  private applyTransform(): void {
    this.video.style.transform = this.viewport.transform;
    this.drawCursor(this.input?.cursor.x ?? 0.5, this.input?.cursor.y ?? 0.5, false);
  }

  private drawCursor(x: number, y: number, active: boolean): void {
    const show = this.mode === 'mouse' && this.settings.showLocalCursor;
    this.cursorEl.hidden = !show;
    if (!show) return;
    const p = this.viewport.toContainer(x, y);
    this.cursorEl.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
    this.cursorEl.classList.toggle('active', active);
  }

  private onVisualViewport = (): void => {
    if (!this.keyboard.open) return;
    this.updateKeyboardInset();
  };

  private onKeyboard(open: boolean, barH: number): void {
    this.el.classList.toggle('kb-open', open);
    this.keyboardInset = open ? barH : 0;
    this.updateKeyboardInset();
  }

  /** Mantém a tela do PC inteira visível acima do teclado nativo + barra de teclas. */
  private updateKeyboardInset(): void {
    const vv = window.visualViewport;
    const imeHeight = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    const bottom = this.keyboard.open ? imeHeight : 0;
    this.keyboard.bar.style.bottom = `${bottom}px`;
    this.stage.style.bottom = `${bottom + (this.keyboard.open ? this.keyboardInset : 0)}px`;
    this.mouseBar.style.bottom = `${bottom + (this.keyboard.open ? this.keyboardInset : 0) + 12}px`;
    requestAnimationFrame(() => {
      this.layout();
      if (this.viewport.isZoomed) {
        this.viewport.ensureVisible(this.input.cursor.x, this.input.cursor.y, 80);
        this.applyTransform();
      }
    });
  }

  // =========================================================================================
  // Barra de ferramentas
  // =========================================================================================
  private canControl(): boolean {
    return this.conn.phase === 'connected' && Boolean(this.conn.permissions?.control);
  }

  private canType(): boolean {
    return this.conn.phase === 'connected' && Boolean(this.conn.permissions?.keyboard);
  }

  private perm(k: keyof PermissionSet): boolean {
    return Boolean(this.conn.permissions?.[k]);
  }

  private showToolbar(show: boolean): void {
    this.toolbar.classList.toggle('visible', show);
    this.hud.classList.toggle('dim', show);
    if (this.hideTimer) clearTimeout(this.hideTimer);
    if (show) this.hideTimer = window.setTimeout(() => this.showToolbar(false), 6000);
  }

  private tool(icon: string, label: string, onClick: () => void, opts: { active?: boolean; disabled?: boolean; testid?: string; danger?: boolean } = {}): HTMLButtonElement {
    const b = h(
      'button',
      { class: 'tool' + (opts.active ? ' active' : '') + (opts.danger ? ' danger' : ''), disabled: opts.disabled, 'data-testid': opts.testid, 'aria-label': label, title: label },
      h('span', { class: 'tool-icon' }, icon),
      h('span', { class: 'tool-label' }, label),
    ) as HTMLButtonElement;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
      this.showToolbar(true);
    });
    return b;
  }

  private renderToolbar(): void {
    clear(this.toolbar);
    const tools: Array<HTMLButtonElement | null> = [
      this.tool('⌨', 'Teclado', () => this.keyboard.toggle(), { active: this.keyboard.open, disabled: !this.perm('keyboard'), testid: 'tool-keyboard' }),
      this.tool(this.mode === 'touch' ? '👆' : '🖱', this.mode === 'touch' ? 'Touch' : 'Mouse', () => this.setMode(this.mode === 'touch' ? 'mouse' : 'touch'), { testid: 'tool-mode' }),
      this.tool(this.viewMode === 'fit' ? '⤢' : '1:1', this.viewMode === 'fit' ? 'Tela completa' : 'Original', () => this.setViewMode(this.viewMode === 'fit' ? 'original' : 'fit'), { testid: 'tool-view' }),
      this.tool('⛶', 'Tela cheia', () => this.toggleImmersive(), { active: this.immersive, testid: 'tool-fullscreen' }),
      this.tool('📶', 'Qualidade', () => this.openQuality(), { testid: 'tool-quality' }),
      this.tool(this.audioOn ? '🔊' : '🔈', 'Áudio', () => this.openAudio(), { active: this.audioOn || this.micOn, disabled: !this.perm('audio') && !this.perm('microphone'), testid: 'tool-audio' }),
      this.tool('⏺', 'Gravar', () => this.openRecording(), { active: Boolean(this.hostRec === 'recording' || this.clientRec), disabled: !this.perm('recording'), testid: 'tool-record' }),
      this.tool('⌘', 'Atalhos', () => this.openShortcuts(), { disabled: !this.perm('keyboard'), testid: 'tool-shortcuts' }),
      this.tool('📋', 'Copiar/colar', () => this.openClipboard(), { disabled: !this.perm('clipboard'), testid: 'tool-clipboard' }),
      this.displays.length > 1 ? this.tool('🖥', 'Monitores', () => this.openDisplays(), { testid: 'tool-displays' }) : null,
      this.perm('admin') ? this.tool('🛡', 'Admin', () => this.openAdmin(), { testid: 'tool-admin' }) : null,
      this.tool('⚙', 'Ajustes', () => this.openInfo(), { testid: 'tool-settings' }),
      this.tool('⏻', 'Desconectar', () => void this.confirmDisconnect(), { danger: true, testid: 'tool-disconnect' }),
    ];
    this.toolbar.append(...tools.filter((t): t is HTMLButtonElement => t !== null));
  }

  private renderMouseBar(): void {
    clear(this.mouseBar);
    const btn = (label: string, b: 0 | 1 | 2) => {
      const el = h('button', { class: 'mb', 'data-testid': `mouse-${b}` }, label);
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.input.button(b, true);
      });
      const up = (e: Event) => {
        e.stopPropagation();
        this.input.button(b, false);
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      return el;
    };
    this.mouseBar.append(btn('Esquerdo', 0), btn('Meio', 1), btn('Direito', 2));
  }

  private setMode(m: ControlMode): void {
    this.mode = m;
    this.mouseBar.hidden = m !== 'mouse';
    store.saveSettings({ controlMode: m });
    this.settings = store.settings();
    this.drawCursor(this.input.cursor.x, this.input.cursor.y, false);
    toast(m === 'touch' ? 'Modo Touch: toque diretamente nos itens da tela' : 'Modo Mouse: deslize para mover o cursor e toque para clicar');
    this.renderToolbar();
  }

  private setViewMode(v: 'fit' | 'original'): void {
    this.viewMode = v;
    store.saveSettings({ viewMode: v });
    this.conn.sendControl({ k: 'quality', preset: this.quality, original: v === 'original' });
    this.applyViewMode();
    this.renderToolbar();
  }

  private toggleImmersive(): void {
    this.immersive = !this.immersive;
    void native.setImmersive(this.immersive);
    this.el.classList.toggle('immersive', this.immersive);
    this.renderToolbar();
  }

  private setAudio(on: boolean): void {
    this.audioOn = on;
    this.video.muted = !on;
    if (on) this.video.play().catch(() => undefined);
    this.conn.sendControl({ k: 'audio', enabled: on, quality: this.settings.audioQuality });
    this.renderToolbar();
  }

  private async confirmDisconnect(): Promise<void> {
    if (await confirmDialog('Desconectar', `Encerrar a sessão com ${this.conn.hostName}?`, { ok: 'Desconectar', danger: true })) {
      this.conn.disconnect();
    }
  }

  // =========================================================================================
  // Folhas (sheets)
  // =========================================================================================
  private openQuality(): void {
    const sheet = openSheet('Qualidade da imagem', [
      segmented<QualityPreset>(
        [
          ['auto', 'Automática'],
          ['high', 'Alta'],
          ['balanced', 'Equilibrada'],
          ['economy', 'Econômica'],
        ],
        this.quality,
        (v) => {
          this.quality = v;
          store.saveSettings({ quality: v });
          this.conn.sendControl({ k: 'quality', preset: v, original: this.viewMode === 'original' });
        },
        'quality-presets',
      ),
      h('p', { class: 'small muted' }, 'Automática ajusta taxa de bits, quadros por segundo e resolução conforme a rede. Econômica reduz o consumo de dados móveis.'),
      switchRow('Resolução original', this.viewMode === 'original', (v) => this.setViewMode(v ? 'original' : 'fit'), 'Mostra 1 pixel do PC por pixel do celular. Use pinça e 3 dedos para navegar.'),
    ]);
    void sheet;
  }

  private openAudio(): void {
    const vol = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(this.video.volume) }) as HTMLInputElement;
    vol.addEventListener('input', () => (this.video.volume = Number(vol.value)));
    openSheet('Áudio', [
      this.perm('audio')
        ? switchRow('Ouvir o som do computador', this.audioOn, (v) => this.setAudio(v), this.audioAvailable ? undefined : 'Este computador não disponibiliza captura de áudio.', 'audio-toggle')
        : h('p', { class: 'muted' }, 'O computador não permitiu áudio para este dispositivo.'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Volume'), vol),
      segmented(
        [
          ['low', 'Baixa'],
          ['medium', 'Média'],
          ['high', 'Alta'],
        ],
        this.settings.audioQuality,
        (v) => {
          this.settings = store.saveSettings({ audioQuality: v });
          if (this.audioOn) this.conn.sendControl({ k: 'audio', enabled: true, quality: v });
        },
      ),
      this.perm('microphone')
        ? switchRow('Microfone do celular → computador', this.micOn, async (v) => {
            const ok = await this.conn.setMic(v);
            this.micOn = ok && v;
            if (v && !ok) toast('Não foi possível usar o microfone. Verifique a permissão do app.', 'error');
            this.renderToolbar();
          }, 'Sua voz será reproduzida nos alto-falantes do computador.')
        : h('p', { class: 'small muted' }, 'Microfone não autorizado pelo computador.'),
    ]);
  }

  private openRecording(): void {
    let target: 'client' | 'host' = 'client';
    let includeAudio = true;
    const body = h('div');
    const render = () => {
      clear(body);
      const hostActive = this.hostRec === 'recording' || this.hostRec === 'paused' || this.hostRec === 'pending';
      if (this.clientRec || hostActive) {
        const where = this.clientRec ? 'neste celular' : 'no computador';
        const paused = this.clientRec ? this.clientRec.state === 'paused' : this.hostRec === 'paused';
        body.append(
          h('div', { class: 'alert rec' }, `● Gravando ${where}${paused ? ' (pausado)' : ''}`),
          h(
            'div',
            { class: 'row-actions' },
            h('button', { class: 'btn', onclick: () => (this.recAction(paused ? 'resume' : 'pause', this.clientRec ? 'client' : 'host'), setTimeout(render, 200)) }, paused ? 'Retomar' : 'Pausar'),
            h('button', { class: 'btn danger', 'data-testid': 'rec-stop', onclick: () => (this.recAction('stop', this.clientRec ? 'client' : 'host'), sheet.close()) }, 'Parar e salvar'),
          ),
        );
        return;
      }
      body.append(
        h('p', { class: 'small muted' }, 'A gravação só é permitida com autorização do computador. Um indicador vermelho fica visível nos dois aparelhos durante toda a gravação.'),
        segmented<'client' | 'host'>(
          [
            ['client', 'Salvar no celular'],
            ['host', 'Salvar no computador'],
          ],
          target,
          (v) => (target = v),
          'rec-target',
        ),
        segmented(
          [
            ['low', 'Baixa'],
            ['medium', 'Média'],
            ['high', 'Alta'],
          ],
          this.settings.recordingQuality,
          (v) => (this.settings = store.saveSettings({ recordingQuality: v })),
        ),
        switchRow('Incluir áudio', includeAudio, (v) => (includeAudio = v)),
        h('button', { class: 'btn primary block', 'data-testid': 'rec-start', onclick: () => (this.startRecording(target, includeAudio), sheet.close()) }, 'Iniciar gravação'),
        this.renderRecordingList(),
      );
    };
    const sheet = openSheet('Gravação da sessão', body);
    render();
  }

  private renderRecordingList(): HTMLElement {
    const nativeList = native.listNativeRecordings();
    const list = nativeList ?? store.recordings().map((r) => ({ name: r.name, size: r.size, createdAt: r.createdAt }));
    return h(
      'div',
      { class: 'list' },
      h('h4', null, 'Gravações neste celular'),
      ...(list.length
        ? list.slice(0, 20).map((r) => h('button', { class: 'list-item', onclick: () => native.openRecording(r.name) }, h('span', null, r.name), h('small', null, `${(r.size / 1048576).toFixed(1)} MB • ${new Date(r.createdAt).toLocaleString('pt-BR')}`)))
        : [h('p', { class: 'small muted' }, 'Nenhuma gravação ainda.')]),
    );
  }

  private startRecording(target: 'client' | 'host', includeAudio: boolean): void {
    if (target === 'host') {
      this.conn.sendControl({ k: 'rec', action: 'start', target: 'host', quality: this.settings.recordingQuality, audio: includeAudio });
    } else {
      this.pendingClientRec = { includeAudio };
      this.conn.sendControl({ k: 'rec', action: 'start', target: 'client' });
    }
  }

  private pendingClientRec: { includeAudio: boolean } | null = null;

  private recAction(action: 'pause' | 'resume' | 'stop', target: 'client' | 'host'): void {
    if (target === 'host') return this.conn.sendControl({ k: 'rec', action, target: 'host' });
    if (!this.clientRec) return;
    if (action === 'pause') {
      this.clientRec.recorder.pause();
      this.clientRec.state = 'paused';
    } else if (action === 'resume') {
      this.clientRec.recorder.resume();
      this.clientRec.state = 'recording';
    } else {
      void this.stopClientRecording();
      return;
    }
    this.conn.sendControl({ k: 'rec', action, target: 'client' });
    this.updateRecIndicator();
  }

  private async onRecState(target: 'host' | 'client', state: RecordingState, message?: string, file?: string): Promise<void> {
    if (target === 'host') {
      this.hostRec = state === 'stopped' || state === 'denied' || state === 'error' ? null : state;
      if (state === 'recording') toast('Gravação iniciada no computador', 'warn');
      if (state === 'stopped') toast(`Gravação salva no computador${file ? `: ${file}` : ''}`, 'ok');
    } else if (state === 'recording' && this.pendingClientRec && this.conn.stream) {
      const opts = this.pendingClientRec;
      this.pendingClientRec = null;
      const stream = opts.includeAudio ? this.conn.stream : new MediaStream(this.conn.stream.getVideoTracks());
      const recorder = new SessionRecorder();
      const mime = pickRecordingMime();
      const name = recordingFileName('RemoteX', mime || 'video/webm');
      const sink = native.recordingSink(name, mime || 'video/webm');
      recorder.start(stream, { quality: this.settings.recordingQuality, onChunk: (b) => sink.write(b), onError: () => toast('Erro na gravação', 'error') });
      this.clientRec = { recorder, sink, name, state: 'recording' };
      toast('Gravando a sessão neste celular', 'warn');
    } else if (state === 'denied' || state === 'error') {
      this.pendingClientRec = null;
      if (this.clientRec) await this.stopClientRecording();
    }
    if (state === 'denied' || state === 'error') toast(message || 'Gravação não autorizada', 'error', 6000);
    this.updateRecIndicator();
    this.renderToolbar();
  }

  private async stopClientRecording(): Promise<void> {
    const r = this.clientRec;
    if (!r) return;
    this.clientRec = null;
    const info = await r.recorder.stop();
    const location = await r.sink.close();
    store.addRecording({ name: r.name, size: info.size, createdAt: new Date().toISOString(), location });
    this.conn.sendControl({ k: 'rec', action: 'stop', target: 'client' });
    toast(`Gravação salva (${(info.size / 1048576).toFixed(1)} MB) em ${location}`, 'ok', 6000);
    this.updateRecIndicator();
    this.renderToolbar();
  }

  private updateRecIndicator(): void {
    const on = Boolean(this.clientRec || this.hostRec);
    this.recPill.hidden = !on;
    const paused = this.clientRec?.state === 'paused' || this.hostRec === 'paused';
    this.recPill.textContent = paused ? '❚❚ REC' : '● REC';
  }

  private openShortcuts(): void {
    const sheet = openSheet(
      'Atalhos',
      h(
        'div',
        { class: 'shortcut-grid' },
        ...SHORTCUTS.map((s) =>
          h(
            'button',
            {
              class: 'shortcut',
              'data-testid': `shortcut-${s.hint}`,
              onclick: () => {
                if (s.special) this.conn.sendControl({ k: 'special', action: s.special });
                else if (s.codes) this.keyboard.combo(s.codes);
                sheet.close();
              },
            },
            h('strong', null, s.label),
            h('small', null, s.hint ?? ''),
          ),
        ),
      ),
      { testid: 'shortcuts-sheet' },
    );
  }

  private openClipboard(): void {
    const text = h('textarea', { class: 'input', rows: 4, placeholder: 'Texto da área de transferência do PC aparece aqui', 'data-testid': 'clip-text' }) as HTMLTextAreaElement;
    text.value = this.lastClip;
    openSheet('Área de transferência', [
      text,
      h(
        'div',
        { class: 'row-actions wrap' },
        h('button', { class: 'btn', onclick: () => this.conn.sendControl({ k: 'clip.get' }) }, 'Atualizar do PC'),
        h('button', { class: 'btn', onclick: async () => (await native.setClipboard(text.value)) && toast('Copiado para o celular', 'ok') }, 'Copiar no celular'),
        h(
          'button',
          {
            class: 'btn primary',
            'data-testid': 'clip-send',
            onclick: async () => {
              const t = text.value || (await native.getClipboard());
              if (!t) return toast('Área de transferência do celular vazia', 'warn');
              this.conn.sendControl({ k: 'clip', text: t });
              toast('Enviado para a área de transferência do PC', 'ok');
            },
          },
          'Enviar ao PC',
        ),
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              const t = text.value || (await native.getClipboard());
              if (!t) return;
              this.conn.sendControl({ k: 'clip', text: t });
              setTimeout(() => this.keyboard.combo(['ControlLeft', 'KeyV']), 150);
            },
          },
          'Colar no PC',
        ),
      ),
      switchRow('Sincronizar automaticamente PC → celular', this.autoClip, (v) => (this.autoClip = v)),
    ]);
    const off = this.conn.on('control', (m) => {
      if (m.k === 'clip' && text.isConnected) text.value = m.text;
      if (!text.isConnected) off();
    });
  }

  private openDisplays(): void {
    const sheet = openSheet(
      'Monitores',
      h(
        'div',
        { class: 'list' },
        ...this.displays.map((d) =>
          h(
            'button',
            {
              class: 'list-item' + (d.id === this.activeDisplay ? ' active' : ''),
              onclick: () => {
                this.conn.sendControl({ k: 'display', id: d.id });
                sheet.close();
              },
            },
            h('span', null, `${d.name}${d.primary ? ' (principal)' : ''}`),
            h('small', null, `${d.width}×${d.height}`),
          ),
        ),
      ),
    );
  }

  // ---- painel administrativo remoto ---------------------------------------------------------
  private rpc<T = any>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.rpcId++;
    this.conn.sendControl({ k: 'rpc', id, method, params });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.rpcWaiters.delete(id);
        reject(new Error('Sem resposta do computador'));
      }, 10_000);
      this.rpcWaiters.set(id, (r) => {
        clearTimeout(t);
        r.ok ? resolve(r.result) : reject(new Error(r.error || 'Erro'));
      });
    });
  }

  private openAdmin(): void {
    const body = h('div', { class: 'admin' }, h('p', { class: 'muted' }, 'Carregando…'));
    const sheet: Sheet = openSheet('Administração do computador', body, { testid: 'admin-sheet', wide: true });
    const fail = (e: unknown) => toast((e as Error).message, 'error');
    const load = async () => {
      try {
        const [ov, trusted, hist] = await Promise.all([this.rpc('admin.overview'), this.rpc<any[]>('admin.listTrusted'), this.rpc<any[]>('admin.history', { limit: 30 })]);
        clear(body);
        const permRow = (dev: any) =>
          h(
            'div',
            { class: 'perm-chips' },
            ...PERMISSION_KEYS.filter((k) => k !== 'view').map((k) => {
              const on = Boolean(dev.permissions[k]);
              return h(
                'button',
                {
                  class: 'chip' + (on ? ' on' : ''),
                  onclick: async () => {
                    try {
                      await this.rpc('admin.updateTrusted', { deviceId: dev.deviceId, permissions: { ...dev.permissions, [k]: !on } });
                      await load();
                    } catch (e) {
                      fail(e);
                    }
                  },
                },
                PERMISSION_LABELS[k],
              );
            }),
          );
        const parts: Array<Node | null> = [
          h('h4', null, `${ov.deviceName} • ${formatDeviceId(ov.deviceId)}`),
          h('p', { class: 'small muted' }, `Executando como administrador: ${ov.elevated ? 'sim' : 'não'}`),
          switchRow('Permitir conexões remotas', ov.incomingEnabled, (v) => this.rpc('admin.setIncoming', { enabled: v }).catch(fail)),
          switchRow('Aceitar pedidos com aprovação', ov.attendedEnabled, (v) => this.rpc('admin.setAttended', { enabled: v }).catch(fail)),
          switchRow('Acesso não assistido', ov.unattendedEnabled, (v) => this.rpc('admin.setUnattended', { enabled: v }).catch(fail), ov.hasPassword ? 'Senha definida' : 'Sem senha definida'),
          !ov.elevated && ov.platform === 'win32'
            ? h(
                'button',
                {
                  class: 'btn block',
                  onclick: async () => {
                    if (!(await confirmDialog('Modo administrador', 'O RemoteX será reiniciado como administrador. Alguém no computador precisará aprovar o aviso do Windows (UAC). A sessão cairá e você poderá reconectar.'))) return;
                    try {
                      const r = await this.rpc<{ ok: boolean; message: string }>('system.requestElevation');
                      toast(r.message, r.ok ? 'ok' : 'warn', 7000);
                    } catch (e) {
                      fail(e);
                    }
                  },
                },
                'Solicitar modo administrador (UAC)',
              )
            : null,
          h('h4', null, 'Dispositivos autorizados'),
          ...(trusted.length
            ? trusted.map((d) =>
                h(
                  'div',
                  { class: 'admin-device' },
                  h('div', { class: 'admin-device-head' }, h('strong', null, d.name), h('small', null, `${formatDeviceId(d.deviceId)} • ${d.fingerprint}`)),
                  switchRow('Acesso não assistido', d.unattended, (v) => this.rpc('admin.updateTrusted', { deviceId: d.deviceId, unattended: v }).then(load).catch(fail)),
                  permRow(d),
                  h(
                    'button',
                    {
                      class: 'btn danger small',
                      onclick: async () => {
                        if (!(await confirmDialog('Revogar', `Revogar o acesso de ${d.name}?`, { ok: 'Revogar', danger: true }))) return;
                        try {
                          await this.rpc('admin.revokeTrusted', { deviceId: d.deviceId });
                          await load();
                        } catch (e) {
                          fail(e);
                        }
                      },
                    },
                    'Revogar',
                  ),
                ),
              )
            : [h('p', { class: 'small muted' }, 'Nenhum dispositivo confiável.')]),
          h('h4', null, 'Histórico de conexões'),
          h(
            'div',
            { class: 'list' },
            ...hist.map((e) => h('div', { class: 'list-item static' }, h('span', null, `${e.clientName} — ${e.result}`), h('small', null, `${new Date(e.requestedAt).toLocaleString('pt-BR')}${e.reason ? ` • ${e.reason}` : ''}`))),
          ),
        ];
        body.append(...parts.filter((x): x is Node => x !== null));
      } catch (e) {
        clear(body);
        body.append(h('p', { class: 'alert error' }, (e as Error).message));
      }
    };
    void load();
    void sheet;
  }

  private openInfo(): void {
    const s = this.conn.stats;
    const perms = this.conn.permissions;
    openSheet('Sessão', [
      h(
        'div',
        { class: 'info-grid' },
        h('span', null, 'Computador'),
        h('strong', null, `${this.conn.hostName} (${formatDeviceId(this.hostId)})`),
        h('span', null, 'Código de verificação'),
        h('strong', { 'data-testid': 'info-sas' }, this.conn.sas || '—'),
        h('span', null, 'Autorização'),
        h('strong', null, (this.conn.method && { password: 'Senha', device: 'Dispositivo confiável', approval: 'Aprovação manual' }[this.conn.method]) || '—'),
        h('span', null, 'Conexão'),
        h('strong', null, s ? PATH_TEXT[s.path] : '—'),
        h('span', null, 'Imagem'),
        h('strong', null, s ? `${s.width}×${s.height} • ${s.fps} fps • ${s.codec}` : '—'),
        h('span', null, 'Latência / perda'),
        h('strong', null, s ? `${s.rttMs ?? '—'} ms • ${s.lossPct}%` : '—'),
        h('span', null, 'Taxa'),
        h('strong', null, s ? `${(s.kbps / 1000).toFixed(2)} Mbps` : '—'),
      ),
      h('h4', null, 'Controle'),
      segmented<ControlMode>(
        [
          ['touch', 'Touch (toque direto)'],
          ['mouse', 'Mouse (touchpad)'],
        ],
        this.mode,
        (v) => this.setMode(v),
      ),
      (() => {
        const r = h('input', { type: 'range', min: '0.4', max: '2.5', step: '0.1', value: String(this.settings.sensitivity) }) as HTMLInputElement;
        r.addEventListener('input', () => (this.settings = store.saveSettings({ sensitivity: Number(r.value) })));
        return h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Sensibilidade do touchpad'), r);
      })(),
      switchRow('Inverter rolagem', this.settings.invertScroll, (v) => (this.settings = store.saveSettings({ invertScroll: v }))),
      switchRow('Mostrar cursor local no modo mouse', this.settings.showLocalCursor, (v) => {
        this.settings = store.saveSettings({ showLocalCursor: v });
        this.applyTransform();
      }),
      switchRow('Abrir teclado ao tocar em campos de texto', this.settings.autoKeyboard, (v) => (this.settings = store.saveSettings({ autoKeyboard: v }))),
      switchRow('Vibração', this.settings.haptics, (v) => (this.settings = store.saveSettings({ haptics: v }))),
      h('h4', null, 'Permissões concedidas'),
      h('div', { class: 'perm-chips' }, ...PERMISSION_KEYS.filter((k) => perms?.[k]).map((k) => h('span', { class: 'chip on' }, PERMISSION_LABELS[k]))),
      h('p', { class: 'small muted' }, 'Gestos: toque = clique • toque longo = botão direito • 2 dedos = rolar • pinça = zoom • 3 dedos = mover a imagem.'),
    ]);
  }

  private renderStatus(s: InboundSummary): void {
    const bars = qualityBars({ rttMs: s.rttMs, lossPct: s.lossPct, fps: s.fps });
    clear(this.statusChip);
    this.statusChip.className = `status-chip q${bars}`;
    this.statusChip.append(
      h('span', { class: 'bars' }, ...[1, 2, 3, 4].map((i) => h('i', { class: i <= bars ? 'on' : '' }))),
      h('span', null, s.rttMs !== null ? `${s.rttMs} ms` : '—'),
    );
    if (s.path === 'relay') this.statusChip.append(h('span', { class: 'small' }, 'TURN'));
  }

  private exit(reconnect: boolean): void {
    this.destroy();
    this.onExit(reconnect);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.conn.phase !== 'ended') this.conn.disconnect();
    this.input.dispose();
    this.resizeObs.disconnect();
    window.visualViewport?.removeEventListener('resize', this.onVisualViewport);
    window.removeEventListener('orientationchange', this.onVisualViewport);
    this.el.remove();
  }
}
