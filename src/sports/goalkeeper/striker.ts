// Striker bot: per-kick timing and kick planning (zone, aim, spin, flight time, tell).

import { zoneTarget } from './physics.ts'
import type { KickPlan, StrikerTell, Vec3, Zone } from './types.ts'

/** Waiting at the ball before the run-up. */
export const IDLE_MS = 1400
export const RUNUP_MS = 1000
/** The doc's 0.5 s stance telegraph. */
export const TELEGRAPH_MS = 500
export const KICK_MS = 120
/**
 * Nominal recover length (rest of the flight after the strike frame). The engine ends recover
 * when the kick resolves, so this is only used for progress display.
 */
export const RECOVER_MS = 900
export const RESULT_MS = 1700

const CORNERS: readonly Zone[] = [0, 2, 6, 8]
const ALL_ZONES: readonly Zone[] = [0, 1, 2, 3, 4, 5, 6, 7, 8]

/** Small seeded PRNG (mulberry32), 0 <= r < 1. For tests and replays. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pickZone(kick: number, rng: () => number, previous: readonly Zone[]): Zone {
  const last = previous.length > 0 ? previous[previous.length - 1] : null
  // Corners get heavier as the shootout progresses: 1.2x at kick 0 up to 2.2x at kick 4.
  const cornerWeight = 1.2 + 0.25 * Math.max(0, Math.min(4, kick))
  let total = 0
  const weights: number[] = []
  for (const z of ALL_ZONES) {
    const w = z === last ? 0 : CORNERS.includes(z) ? cornerWeight : 1
    weights.push(w)
    total += w
  }
  let r = rng() * total
  for (let i = 0; i < ALL_ZONES.length; i++) {
    r -= weights[i]
    if (r < 0) return ALL_ZONES[i]
  }
  // Floating point fallthrough: last non-repeated zone.
  for (let i = ALL_ZONES.length - 1; i >= 0; i--) if (weights[i] > 0) return ALL_ZONES[i]
  return 4
}

function tellFor(zone: Zone, target: Vec3): StrikerTell {
  const side: -1 | 0 | 1 = target.x < -1.2 ? -1 : target.x > 1.2 ? 1 : 0
  return { side, high: Math.floor(zone / 3) === 0 }
}

/** Plan kick number `kick` (0-based). `previous` lists zones already used this shootout. */
export function planKick(kick: number, rng: () => number, previous: readonly Zone[]): KickPlan {
  const zone = pickZone(kick, rng, previous)
  const target = zoneTarget(zone, rng)

  // Sidespin about y: omega_y > 0 curves the ball toward +x for a ball moving +z (omega x v).
  const mag = 15 + rng() * 25
  let sign = rng() < 0.5 ? -1 : 1
  if (Math.abs(target.x) > 0.5 && rng() < 0.5) sign = target.x > 0 ? 1 : -1 // curl toward the target side
  // Small top/backspin about x.
  const omega: Vec3 = { x: (rng() * 2 - 1) * 6, y: sign * mag, z: 0 }

  const k = Math.max(0, Math.min(4, kick))
  const flightTime = 0.95 - (0.27 * k) / 4 + (rng() * 2 - 1) * 0.05

  return { zone, target, omega, flightTime, tell: tellFor(zone, target) }
}
