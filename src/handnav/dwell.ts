// Dwell select: hold the hand cursor on one target until a ring fills, then it is picked.
// Pure logic (no DOM) so it is unit tested in tests/unit/handnav-dwell.test.ts.

export interface DwellConfig {
  /** Hover time needed to pick a target, ms. */
  dwellMs: number
  /** After a pick nothing can fill for this long, ms. */
  cooldownMs: number
  /** A target lost for less than this (tracking jitter) keeps its progress, ms. */
  graceMs: number
  /** Longest frame step counted, ms (a hidden tab must not complete a dwell in one jump). */
  maxStepMs: number
}

export const DEFAULT_DWELL: DwellConfig = { dwellMs: 1200, cooldownMs: 700, graceMs: 220, maxStepMs: 100 }

export interface DwellResult<T> {
  /** Target currently filling, or null. */
  target: T | null
  /** 0 to 1. */
  progress: number
  /** The target that completed on this update, else null. */
  fired: T | null
}

export class DwellTracker<T> {
  private readonly cfg: DwellConfig
  private current: T | null = null
  private elapsed = 0
  private lastT: number | null = null
  private lostAt: number | null = null
  private cooldownUntil = -Infinity
  /** The last picked target must be left before it can fill again. */
  private spent: T | null = null

  constructor(cfg: Partial<DwellConfig> = {}) {
    this.cfg = { ...DEFAULT_DWELL, ...cfg }
  }

  get config(): Readonly<DwellConfig> {
    return this.cfg
  }

  /** Feed the target under the cursor (null for none) at time now (ms). */
  update(target: T | null, now: number): DwellResult<T> {
    const step = this.lastT === null ? 0 : Math.min(Math.max(now - this.lastT, 0), this.cfg.maxStepMs)
    this.lastT = now

    if (this.spent !== null && target !== this.spent) this.spent = null
    if (now < this.cooldownUntil || (target !== null && target === this.spent)) {
      this.clear()
      return { target: null, progress: 0, fired: null }
    }

    if (target === null) {
      if (this.current === null) return { target: null, progress: 0, fired: null }
      this.lostAt ??= now
      if (now - this.lostAt >= this.cfg.graceMs) {
        this.clear()
        return { target: null, progress: 0, fired: null }
      }
      // Brief loss: hold the ring where it is.
      return { target: this.current, progress: this.progress(), fired: null }
    }

    this.lostAt = null
    if (target !== this.current) {
      this.current = target
      this.elapsed = 0
      return { target, progress: 0, fired: null }
    }

    this.elapsed += step
    if (this.elapsed >= this.cfg.dwellMs) {
      const fired = target
      this.clear()
      this.spent = fired
      this.cooldownUntil = now + this.cfg.cooldownMs
      return { target: null, progress: 0, fired }
    }
    return { target, progress: this.progress(), fired: null }
  }

  /** Drop any progress (cursor hidden, screen changed). */
  reset(): void {
    this.clear()
    this.lastT = null
  }

  private progress(): number {
    return Math.min(this.elapsed / this.cfg.dwellMs, 1)
  }

  private clear(): void {
    this.current = null
    this.elapsed = 0
    this.lostAt = null
  }
}
