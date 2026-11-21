// Aero Bow arrow physics: exact constant-acceleration stepping (gravity + lateral wind), segment test
// against the target plane, ring scoring, per-arrow wind and target drift. Pure TypeScript (no DOM,
// no Three.js) so it runs under node tests.

import {
  GRAVITY,
  LAUNCH_POS,
  RING_COUNT,
  RING_WIDTH,
  TARGET_CENTER,
  TARGET_RADIUS,
  TARGET_Z,
  V0_BASE,
  V0_GAIN,
  WIND_FIRST_ARROW,
} from './types.ts'
import type { ShotFlight, ShotInput, Vec2, Vec3 } from './types.ts'

// ---------- constants ----------

/** Fixed physics step, seconds (240 Hz). */
export const PHYS_DT = 1 / 240
/** Flight cap, seconds. A shot still in the air by then ends as 'ground' at its last point. */
export const MAX_FLIGHT_S = 4

/**
 * Wind magnitude ranges, m/s^2: [arrow 3, arrow 4 and later]. Random sign, rounded to 0.1.
 * Drift at the target is 0.5 a t^2 (aim at the centre, t = flight time):
 *   full draw   (v0 50.0, t 0.493 s): arrow 3 0.21..0.34 m (2 to 3.5 rings), arrow 4 0.27..0.41 m
 *   armed draw  (v0 43.4, t 0.568 s): arrow 3 0.27..0.45 m,                  arrow 4 0.36..0.55 m
 *   min draw    (v0 28.0, t 0.889 s): arrow 3 0.67..1.11 m,                  arrow 4 0.87..1.35 m
 */
export const WIND_RANGES: readonly (readonly [number, number])[] = [
  [1.7, 2.8],
  [2.2, 3.4],
]

/**
 * Target drift amplitude, metres: [arrow 3, arrow 4 and later]. Peak sideways speed is
 * 2 pi A / P: 0.29 m/s and 0.46 m/s, so the face moves about 0.14 m and 0.23 m during a full-draw
 * flight. The face edge stays within 1.4 m of the lane centre.
 */
export const DRIFT_AMPLITUDE: readonly number[] = [0.25, 0.4]
/** Target drift period, ms. */
export const DRIFT_PERIOD_MS = 5500

/** Ring-boundary tolerance in ring units, so r = 0.1 scores 9 and r = 0.3 scores 7 despite float error. */
const RING_EPS = 1e-9

// ---------- helpers ----------

export function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0
}

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback
}

function isFinite3(v: Vec3 | null | undefined): v is Vec3 {
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
}

function lerp3(a: Vec3, b: Vec3, u: number): Vec3 {
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u }
}

/** Exact state after time t under constant acceleration (ax, -GRAVITY, 0). */
function advance(p: Vec3, v: Vec3, ax: number, t: number): { p: Vec3; v: Vec3 } {
  const ay = -GRAVITY
  const h = 0.5 * t * t
  return {
    p: { x: p.x + v.x * t + ax * h, y: p.y + v.y * t + ay * h, z: p.z + v.z * t },
    v: { x: v.x + ax * t, y: v.y + ay * t, z: v.z },
  }
}

/** Time until y reaches 0 from height y > 0 with vertical speed vy (positive root, stable form). */
function timeToGround(y: number, vy: number): number {
  const s = Math.sqrt(vy * vy + 2 * GRAVITY * y)
  return vy >= 0 ? (vy + s) / GRAVITY : (2 * y) / (s - vy)
}

/** Wind/drift tier: -1 before WIND_FIRST_ARROW, 0 on arrow 3, 1 on arrow 4 and later. NaN -> -1. */
function windTier(arrow: number): number {
  if (!(arrow >= WIND_FIRST_ARROW)) return -1
  return Math.min(Math.floor(arrow) - WIND_FIRST_ARROW, WIND_RANGES.length - 1)
}

// ---------- launch ----------

/** V0_BASE + V0_GAIN * clamp01(tension), m/s. NaN -> V0_BASE. */
export function launchSpeed(tension: number): number {
  return V0_BASE + V0_GAIN * clamp01(tension)
}

/**
 * Launch velocity of magnitude `speed` whose gravity-only path passes through `aim` (low arc). Yaw
 * toward aim; pitch from tan(theta) = (v^2 - sqrt(v^4 - g(g d^2 + 2 h v^2))) / (g d). Out of range:
 * 45 degrees toward aim. Invalid speed returns zero velocity; non-finite points fall back to
 * LAUNCH_POS and the target centre.
 */
export function solveLaunch(from: Vec3, aim: Vec3, speed: number): Vec3 {
  if (!(speed > 0) || !Number.isFinite(speed)) return { x: 0, y: 0, z: 0 }
  const f = isFinite3(from) ? from : LAUNCH_POS
  const a = isFinite3(aim) ? aim : { x: TARGET_CENTER.x, y: TARGET_CENTER.y, z: TARGET_Z }
  const dx = a.x - f.x
  const dz = a.z - f.z
  const h = a.y - f.y
  const d = Math.hypot(dx, dz)
  if (d < 1e-6) {
    // Aim straight above or below; flat toward the target when aim is the launch point.
    if (Math.abs(h) < 1e-6) return { x: 0, y: 0, z: -speed }
    return { x: 0, y: Math.sign(h) * speed, z: 0 }
  }
  const v2 = speed * speed
  const q = GRAVITY * d * d + 2 * h * v2
  const disc = v2 * v2 - GRAVITY * q
  // Low arc in the cancellation-free form q / (d (v^2 + sqrt(disc))).
  const theta = disc >= 0 ? Math.atan(q / (d * (v2 + Math.sqrt(disc)))) : Math.PI / 4
  const c = Math.cos(theta)
  return { x: (speed * c * dx) / d, y: speed * Math.sin(theta), z: (speed * c * dz) / d }
}

// ---------- flight ----------

/**
 * Step the arrow at PHYS_DT with the exact constant-acceleration update (wind on x, gravity on y)
 * until it crosses z = TARGET_Z ('target', scored against the centre at that moment), lands
 * (y <= 0 first: 'ground') or reaches MAX_FLIGHT_S ('ground' at the last point). Crossing and landing
 * points are solved exactly inside the step, so the last path interval is shorter than stepS.
 */
export function simulateShot(opts: ShotInput): ShotFlight {
  const dt = PHYS_DT
  const ax = finiteOr(opts.windAccel, 0)
  const from = isFinite3(opts.from) ? opts.from : LAUNCH_POS
  const v0 = isFinite3(opts.velocity) ? opts.velocity : { x: 0, y: 0, z: 0 }
  let p: Vec3 = { x: from.x, y: from.y, z: from.z }
  let v: Vec3 = { x: v0.x, y: v0.y, z: v0.z }
  const path: Vec3[] = [p]
  const vel: Vec3[] = [v]

  const finish = (end: 'target' | 'ground', impact: Vec3, tS: number): ShotFlight => {
    const c = opts.targetCenterAt(tS * 1000)
    const center: Vec2 =
      c && Number.isFinite(c.x) && Number.isFinite(c.y)
        ? { x: c.x, y: c.y }
        : { x: TARGET_CENTER.x, y: TARGET_CENTER.y }
    let hit: Vec2 | null = null
    let radius = Infinity
    let score = 0
    if (end === 'target') {
      hit = { x: impact.x - center.x, y: impact.y - center.y }
      radius = Math.hypot(hit.x, hit.y)
      score = ringScore(radius)
    }
    return {
      path,
      vel,
      stepS: dt,
      flightMs: tS * 1000,
      end,
      impact,
      hit,
      radius,
      score,
      // Wind is x-only, so it never changes the crossing or landing time.
      windErrX: 0.5 * ax * tS * tS,
      targetCenter: center,
    }
  }

  if (p.y <= 0) {
    const impact = { x: p.x, y: 0, z: p.z }
    path.push(impact)
    vel.push({ ...v })
    return finish('ground', impact, 0)
  }

  const maxSteps = Math.ceil(MAX_FLIGHT_S / dt - 1e-9)
  for (let k = 1; k <= maxSteps; k++) {
    const next = advance(p, v, ax, dt)
    let tauPlane = Infinity
    let tauGround = Infinity
    // Segment p -> next against the plane; z is linear in time, so this tau is exact.
    if (p.z > TARGET_Z && next.p.z <= TARGET_Z) tauPlane = (p.z - TARGET_Z) / -v.z
    if (next.p.y <= 0) tauGround = timeToGround(p.y, v.y)
    if (tauPlane < Infinity || tauGround < Infinity) {
      const toGround = tauGround < tauPlane
      const tau = Math.min(Math.max(toGround ? tauGround : tauPlane, 0), dt)
      const s = advance(p, v, ax, tau)
      if (toGround) s.p.y = 0
      else s.p.z = TARGET_Z
      path.push(s.p)
      vel.push(s.v)
      return finish(toGround ? 'ground' : 'target', s.p, (k - 1) * dt + tau)
    }
    p = next.p
    v = next.v
    path.push(p)
    vel.push(v)
  }
  return finish('ground', p, maxSteps * dt)
}

/**
 * Position and velocity at tS seconds after launch, linearly interpolated between path samples
 * (error under 0.03 mm at 240 Hz). Clamped to [0, flight end].
 */
export function sampleFlight(flight: ShotFlight, tS: number): { p: Vec3; v: Vec3 } {
  const { path, vel, stepS } = flight
  const n = path.length
  if (n < 2) return { p: { ...path[0] }, v: { ...vel[0] } }
  const tEnd = flight.flightMs / 1000
  const t = Math.min(Math.max(finiteOr(tS, 0), 0), tEnd)
  const i = Math.min(Math.floor(t / stepS), n - 2)
  const t0 = i * stepS
  const t1 = i === n - 2 ? tEnd : t0 + stepS
  const u = t1 > t0 ? clamp01((t - t0) / (t1 - t0)) : 1
  return { p: lerp3(path[i], path[i + 1], u), v: lerp3(vel[i], vel[i + 1], u) }
}

// ---------- scoring ----------

/** 10 - floor(r / RING_WIDTH) for 0 <= r < TARGET_RADIUS, else 0 (miss). NaN -> 0. */
export function ringScore(r: number): number {
  if (!(r >= 0) || r >= TARGET_RADIUS) return 0
  const k = Math.floor(r / RING_WIDTH + RING_EPS)
  return k >= RING_COUNT ? 0 : RING_COUNT - k
}

// ---------- wind and drift ----------

/**
 * Lateral wind acceleration for an arrow, m/s^2 (+x right). 0 before WIND_FIRST_ARROW; afterwards a
 * random sign and a magnitude from WIND_RANGES (see the drift table there), rounded to 0.1.
 */
export function windForArrow(arrow: number, rng: () => number): number {
  const tier = windTier(arrow)
  if (tier < 0) return 0
  const [lo, hi] = WIND_RANGES[tier]
  const sign = clamp01(finiteOr(rng(), 0.5)) < 0.5 ? -1 : 1
  const m = lo + (hi - lo) * clamp01(finiteOr(rng(), 0.5))
  return (sign * Math.round(m * 10)) / 10
}

/**
 * Target centre at round time tMs. TARGET_CENTER before WIND_FIRST_ARROW; afterwards a slow sideways
 * sine, x = TARGET_CENTER.x + A sin(2 pi tMs / DRIFT_PERIOD_MS + phase), y unchanged.
 */
export function targetCenterAt(arrow: number, tMs: number, phase: number): Vec2 {
  const tier = windTier(arrow)
  if (tier < 0) return { x: TARGET_CENTER.x, y: TARGET_CENTER.y }
  const w = (2 * Math.PI * finiteOr(tMs, 0)) / DRIFT_PERIOD_MS + finiteOr(phase, 0)
  return { x: TARGET_CENTER.x + DRIFT_AMPLITUDE[tier] * Math.sin(w), y: TARGET_CENTER.y }
}
