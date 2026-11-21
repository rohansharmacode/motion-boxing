export interface Point { x: number; y: number; z: number }
export interface Landmark extends Point { visibility?: number }
export type Pose = readonly (Landmark | null | undefined)[]
export interface Frame { timeMs: number; image: Pose; world: Pose }
export interface FilterOptions { minCutoff?: number; beta?: number; dCutoff?: number }

export function visible(p: Landmark | null | undefined): p is Landmark {
  return !!p && [p.x, p.y, p.z, p.visibility ?? 1].every(Number.isFinite)
    && (p.visibility ?? 1) > 0.5
}
const alpha = (hz: number, dt: number) => 1 / (1 + 1 / (2 * Math.PI * hz * dt))

export class OneEuroFilter {
  private prevTime = NaN
  private raw = 0
  private value = 0
  private speed = 0
  private readonly min: number
  private readonly beta: number
  private readonly derivative: number

  constructor(options: FilterOptions = {}) {
    this.min = options.minCutoff ?? 1.5
    this.beta = options.beta ?? 0.08
    this.derivative = options.dCutoff ?? 1
    if (![this.min, this.beta, this.derivative].every(Number.isFinite)
      || this.min <= 0 || this.derivative <= 0 || this.beta < 0) throw new RangeError('Invalid filter settings')
  }

  reset() { this.prevTime = NaN }

  update(value: number, timeMs: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(timeMs)) throw new RangeError('Invalid sample')
    const dt = (timeMs - this.prevTime) / 1000
    if (dt <= 0) throw new RangeError('Timestamps must increase')
    if (Number.isNaN(dt)) {
      this.value = value
      this.speed = 0
    } else {
      this.speed += alpha(this.derivative, dt) * ((value - this.raw) / dt - this.speed)
      this.value += alpha(this.min + this.beta * Math.abs(this.speed), dt) * (value - this.value)
    }
    this.raw = value
    this.prevTime = timeMs
    return this.value
  }
}

export class LandmarkSmoother {
  private readonly axes: OneEuroFilter[][]
  constructor(options: FilterOptions = {}) {
    this.axes = Array.from({ length: 33 }, () => Array.from({ length: 3 }, () => new OneEuroFilter(options)))
  }
  reset() { for (const joint of this.axes) for (const axis of joint) axis.reset() }
  update(pose: Pose, timeMs: number): (Landmark | null)[] {
    return this.axes.map(([x, y, z], i) => {
      const p = pose[i]
      if (!visible(p)) {
        x.reset(); y.reset(); z.reset()
        return null
      }
      return { x: x.update(p.x, timeMs), y: y.update(p.y, timeMs), z: z.update(p.z, timeMs), visibility: p.visibility }
    })
  }
}

export interface Calibration {
  shoulderWidth: number
  torsoCenter: { x: number; y: number }
  neutralNose: { x: number; y: number }
}

export class Calibrator {
  private count = 0
  private sums = [0, 0, 0, 0, 0]
  private result?: Calibration
  update(pose: Pose): Calibration | undefined {
    if (this.result) return this.result
    const [nose, left, right] = [pose[0], pose[11], pose[12]]
    if (!visible(nose) || !visible(left) || !visible(right)) return
    const width = Math.hypot(left.x - right.x, left.y - right.y)
    if (width < 0.02) return
    const sample = [width, 1 - (left.x + right.x) / 2, (left.y + right.y) / 2, 1 - nose.x, nose.y]
    sample.forEach((n, i) => { this.sums[i] += n })
    if (++this.count === 15) {
      const [shoulderWidth, x, y, nx, ny] = this.sums.map(n => n / 15)
      this.result = { shoulderWidth, torsoCenter: { x, y }, neutralNose: { x: nx, y: ny } }
    }
    return this.result
  }
}
