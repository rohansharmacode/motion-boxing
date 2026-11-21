// 1-euro filter (Casiez, Roussel & Vogel, CHI 2012). Goalkeeper tuning: minCutoff 1.2 Hz, beta 0.12.

import type { Vec3 } from './types.ts'

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff)
  return 1 / (1 + tau / dt)
}

export class OneEuroFilter {
  minCutoff: number
  beta: number
  dCutoff: number
  private xPrev: number | null = null
  private dxPrev = 0
  private tPrev = 0

  constructor(minCutoff = 1.2, beta = 0.12, dCutoff = 1.0) {
    this.minCutoff = minCutoff
    this.beta = beta
    this.dCutoff = dCutoff
  }

  filter(value: number, tSeconds: number): number {
    if (this.xPrev === null) {
      this.xPrev = value
      this.dxPrev = 0
      this.tPrev = tSeconds
      return value
    }
    const dt = tSeconds - this.tPrev
    if (!(dt > 0)) return this.xPrev
    const dx = (value - this.xPrev) / dt
    const ad = alpha(this.dCutoff, dt)
    const dxHat = ad * dx + (1 - ad) * this.dxPrev
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat)
    const a = alpha(cutoff, dt)
    const xHat = a * value + (1 - a) * this.xPrev
    this.xPrev = xHat
    this.dxPrev = dxHat
    this.tPrev = tSeconds
    return xHat
  }

  reset(): void {
    this.xPrev = null
    this.dxPrev = 0
    this.tPrev = 0
  }
}

export class OneEuroVec3 {
  private fx: OneEuroFilter
  private fy: OneEuroFilter
  private fz: OneEuroFilter

  constructor(minCutoff = 1.2, beta = 0.12, dCutoff = 1.0) {
    this.fx = new OneEuroFilter(minCutoff, beta, dCutoff)
    this.fy = new OneEuroFilter(minCutoff, beta, dCutoff)
    this.fz = new OneEuroFilter(minCutoff, beta, dCutoff)
  }

  filter(v: Vec3, tSeconds: number): Vec3 {
    return {
      x: this.fx.filter(v.x, tSeconds),
      y: this.fy.filter(v.y, tSeconds),
      z: this.fz.filter(v.z, tSeconds),
    }
  }

  reset(): void {
    this.fx.reset()
    this.fy.reset()
    this.fz.reset()
  }
}
