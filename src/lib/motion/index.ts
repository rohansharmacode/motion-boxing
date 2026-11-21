import { LandmarkSmoother, visible } from './pose'
import type { Calibration, FilterOptions, Frame, Landmark, Point, Pose } from './pose'
import { RoundMetrics } from './metrics'
import type { Hand, Metrics } from './metrics'
export * from './pose'
export type { Hand, Metrics } from './metrics'

type Punch = 'jab' | 'cross' | 'hook' | 'uppercut'
type Posture = 'guard' | 'slip' | 'duck'
export interface MotionEvent extends Metrics {
  kind: Punch | Posture
  timeMs: number
  hand?: Hand
  confidence: number
}
interface Sample { x: number; y: number; z: number; angle: number }
interface Arm {
  prev?: Sample
  origin?: Sample
  fired: boolean
  quietMs: number
  peak: number
  lastFire: number
}
const arm = (): Arm => ({ fired: false, quietMs: 0, peak: 0, lastFire: -Infinity })
function angle(a: Point, b: Point, c: Point) {
  const u = [a.x-b.x, a.y-b.y, a.z-b.z], v = [c.x-b.x, c.y-b.y, c.z-b.z]
  const length = Math.hypot(...u) * Math.hypot(...v)
  if (length < 1e-6) return NaN
  return Math.acos(Math.max(-1, Math.min(1, u.reduce((sum, n, i) => sum + n*v[i], 0) / length))) * 180 / Math.PI
}
const confidence = (...joints: Landmark[]) => Math.min(1, ...joints.map(j => j.visibility ?? 1))

export class PunchClassifier {
  private image: LandmarkSmoother
  private world: LandmarkSmoother
  private last = -Infinity
  private arms = { left: arm(), right: arm() }
  private metrics = new RoundMetrics()
  private held = { guard: false, duck: false, slip: false }
  private trackingMs = 0
  private previousGuard: boolean | null = null

  private readonly calibration: Calibration
  constructor(calibration: Calibration, options: FilterOptions = {}) {
    this.calibration = calibration
    this.image = new LandmarkSmoother(options)
    this.world = new LandmarkSmoother(options)
  }
  markCue(timeMs: number) { this.metrics.markCue(timeMs) }

  private loseArm(hand: Hand) {
    const { fired, origin, lastFire } = this.arms[hand]
    this.arms[hand] = { ...arm(), fired, origin: fired ? origin : undefined, lastFire }
  }
  private losePose() {
    this.image.reset(); this.world.reset()
    this.loseArm('left'); this.loseArm('right')
    this.trackingMs = 0
    this.previousGuard = null
    // Preserve posture latches until a visible release.
  }

  update(frame: Frame): MotionEvent[] {
    const { timeMs } = frame
    if (!Number.isFinite(timeMs) || timeMs <= this.last) return []
    const elapsed = timeMs - this.last
    this.last = timeMs
    if (elapsed > 150) this.losePose()
    const dt = elapsed > 150 ? 0 : elapsed
    const { shoulderWidth: sw, torsoCenter: c, neutralNose } = this.calibration
    const l = frame.image[11], r = frame.image[12]
    if (!visible(l) || !visible(r) || Math.abs(1-(l.x+r.x)/2-c.x) > sw*0.8
      || Math.abs((l.y+r.y)/2-c.y) > sw*0.9
      || Math.abs(Math.hypot(l.x-r.x,l.y-r.y)/sw-1) > 0.45) {
      this.losePose()
      return []
    }
    const image = this.image.update(frame.image, timeMs)
    const world = this.world.update(frame.world, timeMs)
    this.trackingMs += dt
    const events: MotionEvent[] = []
    const nose = image[0], left = image[15], right = image[16]
    const ready = this.trackingMs >= 100
    const guard = nose && left && right ? [left,right].every((w,i) =>
      Math.hypot(w.x-nose.x,w.y-nose.y) < 0.45*sw && w.y < image[11+i]!.y) : null
    if (ready && guard !== null && this.previousGuard !== null) this.metrics.observeGuard(dt, this.previousGuard)
    this.previousGuard = ready ? guard : null
    const posture = (kind: Posture, active: boolean, score: number) => {
      if (active && !this.held[kind]) events.push({ kind, timeMs, confidence: score, ...this.metrics.event(timeMs, 0) })
      this.held[kind] = active
    }
    if (ready && nose) {
      const score = confidence(l,r,nose)
      if (guard !== null) posture('guard', guard, Math.min(score, confidence(left!, right!)))
      posture('slip', Math.abs(1-nose.x-c.x) > 0.35*sw, score)
      posture('duck', nose.y-neutralNose.y > 0.25*sw, score)
    }
    for (const hand of ['left','right'] as const) {
      const event = this.classifyArm(hand, image, world, frame.world, timeMs, dt, ready)
      if (event) events.push(event)
    }
    return events
  }

  private classifyArm(hand: Hand, image: Pose, world: Pose, rawWorld: Pose, timeMs: number, dtMs: number, ready: boolean): MotionEvent | undefined {
    const i = hand === 'left' ? 11 : 12
    const shoulder = image[i], elbow = image[i+2], wrist = image[i+4]
    const a = world[i], b = world[i+2], w = world[i+4], other = world[23-i]
    if (!visible(shoulder) || !visible(elbow) || !visible(wrist) || !visible(a) || !visible(b) || !visible(w) || !visible(other)) {
      this.loseArm(hand)
      return
    }
    const sw = this.calibration.shoulderWidth
    const widthM = Math.hypot(a.x-other.x,a.y-other.y,a.z-other.z)
    const theta = angle(a,b,w)
    if (!Number.isFinite(theta) || widthM < 0.1) { this.loseArm(hand); return }
    const mid = (image[11]!.x + image[12]!.x)/2
    const sample = { x: (mid-wrist.x)/sw, y: (wrist.y-shoulder.y)/sw, z: (w.z-a.z)/widthM, angle: theta }
    const state = this.arms[hand], prev = state.prev
    state.prev = sample
    if (!prev || !dtMs) return
    const hz = 1000/dtMs
    const vx = (sample.x-prev.x)*hz, vy = (sample.y-prev.y)*hz
    const speed = Math.hypot(vx, vy, (sample.z-prev.z)*hz)
    state.quietMs = speed < 0.75 ? state.quietMs+dtMs : 0
    const origin = state.origin
    if (state.quietMs >= 65 && (!state.fired || (origin &&
      Math.hypot(sample.x-origin.x,sample.y-origin.y,sample.z-origin.z) < 0.35))) {
      state.origin = sample
      state.fired = false
      state.peak = 0
    }
    if (!ready || !origin || state.fired || timeMs-state.lastFire < 220) return
    state.peak = Math.max(state.peak, speed)
    let kind: Punch
    if ((theta-prev.angle)*hz > 280 && theta > 140 && w.z-a.z < -0.18) {
      // Sample twist at impact. Filtering the two shoulders delays the twist
      // past the elbow-extension gate on a fast cross.
      kind = Math.abs(rawWorld[i]!.z-rawWorld[23-i]!.z) > 0.12 ? 'cross' : 'jab'
    } else if (Math.abs(vx) > 2.2 && prev.x*sample.x <= 0 && theta > 70 && theta < 130
      && Math.abs(sample.x-origin.x) > 0.18) {
      kind = 'hook'
    } else if (vy < -2 && origin.y > 0 && origin.y-sample.y > 0.18) {
      kind = 'uppercut'
    } else return
    state.fired = true
    state.lastFire = timeMs
    return { kind, hand, timeMs, confidence: confidence(shoulder,elbow,wrist,a,b,w,other),
      ...this.metrics.event(timeMs, state.peak, hand) }
  }
}
