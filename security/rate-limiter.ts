/**
 * Limitadores de taxa usados contra força bruta e abuso.
 *
 * - SlidingWindowLimiter: N eventos por janela de tempo por chave.
 * - LockoutTracker: bloqueio exponencial após falhas consecutivas de autenticação.
 *
 * Estado em memória (por instância). Para múltiplas instâncias do servidor, troque por Redis
 * mantendo a mesma interface (ver documentation/IMPLANTACAO.md).
 */
export type Clock = () => number;

export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: Clock = Date.now,
  ) {}

  /** Registra uma tentativa; retorna false se o limite foi excedido. */
  hit(key: string): boolean {
    const t = this.now();
    const arr = (this.hits.get(key) || []).filter((x) => t - x < this.windowMs);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(t);
    this.hits.set(key, arr);
    return true;
  }

  remaining(key: string): number {
    const t = this.now();
    const arr = (this.hits.get(key) || []).filter((x) => t - x < this.windowMs);
    return Math.max(0, this.limit - arr.length);
  }

  /** Remove chaves expiradas para limitar uso de memória. */
  sweep(): void {
    const t = this.now();
    for (const [k, arr] of this.hits) {
      const kept = arr.filter((x) => t - x < this.windowMs);
      if (kept.length === 0) this.hits.delete(k);
      else this.hits.set(k, kept);
    }
  }
}

export interface LockoutState {
  failures: number;
  lockedUntil: number;
}

export class LockoutTracker {
  private state = new Map<string, LockoutState>();

  /**
   * @param threshold falhas permitidas antes do primeiro bloqueio
   * @param baseLockMs duração do primeiro bloqueio; dobra a cada novo bloqueio
   * @param maxLockMs duração máxima do bloqueio
   */
  constructor(
    private readonly threshold = 5,
    private readonly baseLockMs = 60_000,
    private readonly maxLockMs = 60 * 60_000,
    private readonly now: Clock = Date.now,
  ) {}

  isLocked(key: string): number {
    const s = this.state.get(key);
    if (!s) return 0;
    const left = s.lockedUntil - this.now();
    return left > 0 ? left : 0;
  }

  fail(key: string): number {
    const s = this.state.get(key) || { failures: 0, lockedUntil: 0 };
    s.failures += 1;
    if (s.failures >= this.threshold) {
      const level = s.failures - this.threshold;
      const dur = Math.min(this.maxLockMs, this.baseLockMs * 2 ** level);
      s.lockedUntil = this.now() + dur;
    }
    this.state.set(key, s);
    return this.isLocked(key);
  }

  success(key: string): void {
    this.state.delete(key);
  }

  snapshot(key: string): LockoutState | undefined {
    const s = this.state.get(key);
    return s ? { ...s } : undefined;
  }
}
