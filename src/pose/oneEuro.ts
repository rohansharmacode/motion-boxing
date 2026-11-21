// 1-euro filter (Casiez, Roussel, Vogel, CHI 2012): a low-pass filter whose cutoff rises with speed,
// so idle jitter is smoothed hard while fast motion passes with little lag.

export interface OneEuroParams {
  /** Hz. Cutoff at rest: lower means smoother and laggier when still. */
  minCutoff: number
  /** Cutoff gain per unit/s of speed. Depends on the units of the filtered value. */
  beta: number
  /** Hz. Cutoff of the speed estimate. */
  dCutoff: number
}

/** Smoothing factor of a one-pole low-pass filter with this cutoff (Hz) at this step (s). */
function alpha(cutoffHz: number, dtS: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz)
  return 1 / (1 + tau / dtS)
}

export class OneEuroFilter {
  private readonly params: OneEuroParams
  private x = 0
  private dx = 0
  private lastT = 0
  private primed = false

  constructor(params: OneEuroParams) {
    this.params = params
  }

  /** Filter one sample taken at tMs (ms, increasing). Returns the filtered value. */
  filter(value: number, tMs: number): number {
    if (!this.primed) {
      this.primed = true
      this.x = value
      this.dx = 0
      this.lastT = tMs
      return value
    }
    const dt = (tMs - this.lastT) / 1000
    // Same or older timestamp: nothing to integrate, keep the current estimate.
    if (!(dt > 0)) return this.x
    this.lastT = tMs

    const { minCutoff, beta, dCutoff } = this.params
    const rawDx = (value - this.x) / dt
    const aD = alpha(dCutoff, dt)
    this.dx = aD * rawDx + (1 - aD) * this.dx
    const a = alpha(minCutoff + beta * Math.abs(this.dx), dt)
    this.x = a * value + (1 - a) * this.x
    return this.x
  }

  reset(): void {
    this.primed = false
    this.x = 0
    this.dx = 0
    this.lastT = 0
  }
}
