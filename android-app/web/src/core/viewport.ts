/**
 * Viewport da tela remota no celular: zoom, movimentação e conversão de coordenadas.
 *  - MODO "fit" (Tela completa): a tela do PC ocupa a maior área possível sem distorção.
 *  - MODO "original": 1 pixel do PC = 1 pixel físico do celular, com movimentação.
 * A imagem nunca é esticada: a escala é sempre uniforme (mesma em X e Y).
 */
export class Viewport {
  cw = 1;
  ch = 1;
  vw = 1;
  vh = 1;
  scale = 1;
  tx = 0;
  ty = 0;
  dpr = 1;
  /** Largura real (px) da tela do computador — pode ser maior que o vídeo se reduzido. */
  remoteW = 0;

  setContainer(w: number, h: number): void {
    this.cw = Math.max(1, w);
    this.ch = Math.max(1, h);
  }

  setContent(w: number, h: number): void {
    this.vw = Math.max(1, w);
    this.vh = Math.max(1, h);
  }

  get fitScale(): number {
    return Math.min(this.cw / this.vw, this.ch / this.vh);
  }

  /** Escala em que 1 px do computador ocupa 1 px físico do celular. */
  get originalScale(): number {
    const pcPxPerVideoPx = this.remoteW > 0 ? this.remoteW / this.vw : 1;
    return pcPxPerVideoPx / this.dpr;
  }

  get minScale(): number {
    return Math.min(this.fitScale, this.originalScale);
  }

  get maxScale(): number {
    return Math.max(this.fitScale * 8, this.originalScale * 4);
  }

  get isZoomed(): boolean {
    return this.scale > this.fitScale * 1.01;
  }

  fit(): void {
    this.scale = this.fitScale;
    this.clamp();
  }

  original(focus?: { x: number; y: number }): void {
    const f = focus ?? { x: this.cw / 2, y: this.ch / 2 };
    this.zoomAt(this.originalScale / this.scale, f.x, f.y);
  }

  /** Amplia/reduz mantendo fixo o ponto (cx, cy) do contêiner. */
  zoomAt(factor: number, cx: number, cy: number): void {
    const next = Math.min(this.maxScale, Math.max(this.minScale, this.scale * factor));
    const k = next / this.scale;
    this.tx = cx - (cx - this.tx) * k;
    this.ty = cy - (cy - this.ty) * k;
    this.scale = next;
    this.clamp();
  }

  panBy(dx: number, dy: number): void {
    this.tx += dx;
    this.ty += dy;
    this.clamp();
  }

  /** Centraliza o eixo menor que o contêiner e impede bordas vazias no eixo maior. */
  clamp(): void {
    const w = this.vw * this.scale;
    const h = this.vh * this.scale;
    this.tx = w <= this.cw ? (this.cw - w) / 2 : Math.min(0, Math.max(this.cw - w, this.tx));
    this.ty = h <= this.ch ? (this.ch - h) / 2 : Math.min(0, Math.max(this.ch - h, this.ty));
  }

  /** Ponto do contêiner → coordenada normalizada (0..1) da tela remota. */
  toRemote(x: number, y: number): { x: number; y: number; inside: boolean } {
    const nx = (x - this.tx) / (this.vw * this.scale);
    const ny = (y - this.ty) / (this.vh * this.scale);
    return { x: Math.min(1, Math.max(0, nx)), y: Math.min(1, Math.max(0, ny)), inside: nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1 };
  }

  /** Coordenada normalizada → ponto do contêiner. */
  toContainer(nx: number, ny: number): { x: number; y: number } {
    return { x: this.tx + nx * this.vw * this.scale, y: this.ty + ny * this.vh * this.scale };
  }

  /** Move a imagem o mínimo necessário para o ponto remoto ficar visível (com margem). */
  ensureVisible(nx: number, ny: number, margin = 40): boolean {
    const p = this.toContainer(nx, ny);
    let dx = 0;
    let dy = 0;
    if (p.x < margin) dx = margin - p.x;
    else if (p.x > this.cw - margin) dx = this.cw - margin - p.x;
    if (p.y < margin) dy = margin - p.y;
    else if (p.y > this.ch - margin) dy = this.ch - margin - p.y;
    if (!dx && !dy) return false;
    const before = { tx: this.tx, ty: this.ty };
    this.panBy(dx, dy);
    return before.tx !== this.tx || before.ty !== this.ty;
  }

  get transform(): string {
    return `translate3d(${this.tx}px, ${this.ty}px, 0) scale(${this.scale})`;
  }
}
