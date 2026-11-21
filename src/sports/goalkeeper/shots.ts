// Shot variety for Reflex Keeper: straight, curling, dipping, low skimmer and top-corner shots, plus
// optional fake-outs on the wind-up arrow. Pure and seeded (rng in, plan out) so it is unit tested.

import type { DifficultyParams } from './difficulty.ts'
import { GOAL_HALF_WIDTH, zoneOf } from './physics.ts'
import { planKick, spreadTarget } from './striker.ts'
import type { KickPlan, StrikerTell, Zone } from './types.ts'

export type ShotType = 'straight' | 'curl' | 'dip' | 'skimmer' | 'topCorner'

export const SHOT_TYPES: readonly ShotType[] = ['straight', 'curl', 'dip', 'skimmer', 'topCorner']

export interface ShotPlan extends KickPlan {
  shot: ShotType
  /** Tell shown first when the striker feints, null for an honest wind-up. */
  fake: StrikerTell | null
  /** Fraction 0..1 of the wind-up after which the real tell replaces the fake. */
  fakeUntil: number
}

/** Weighted pick from a level's shot mix. */
export function pickShotType(rng: () => number, mix: DifficultyParams['mix']): ShotType {
  let total = 0
  for (const t of SHOT_TYPES) total += Math.max(0, mix[t])
  if (total <= 0) return 'straight'
  let r = rng() * total
  for (const t of SHOT_TYPES) {
    r -= Math.max(0, mix[t])
    if (r < 0) return t
  }
  return 'straight'
}

const rand = (rng: () => number, lo: number, hi: number): number => lo + (hi - lo) * rng()

/** Which side the arrow points and whether it lifts. Same thresholds as striker.ts. */
export function tellOf(x: number, zone: Zone): StrikerTell {
  return { side: x < -1.2 ? -1 : x > 1.2 ? 1 : 0, high: Math.floor(zone / 3) === 0 }
}

/**
 * Plan kick `kick` (0-based) for a level. `speed` is the level speed with the auto-ramp applied.
 * Every shot still arrives at its target (solveLaunch accounts for spin), so the shape is visual
 * and the reaction window comes from flight time.
 */
export function planShot(
  kick: number,
  rng: () => number,
  previous: readonly Zone[],
  level: DifficultyParams,
  speed: number,
): ShotPlan {
  const shot = pickShotType(rng, level.mix)
  // Base plan (zone choice that avoids repeats, timing curve over the shootout).
  const base = planKick(kick, rng, previous, { speed, curve: level.curve, spread: level.spread })
  const t = base.target
  const omega = base.omega
  let flightTime = base.flightTime

  switch (shot) {
    case 'straight':
      omega.x *= 0.2
      omega.y *= 0.2
      break
    case 'curl': {
      // Strong sidespin that bends the ball toward the side it is aimed at.
      const sign = Math.abs(t.x) > 0.3 ? Math.sign(t.x) : rng() < 0.5 ? -1 : 1
      omega.y = sign * rand(rng, 34, 48) * level.curve
      omega.x *= 0.3
      break
    }
    case 'dip':
      // Topspin (omega.x > 0 with v.z > 0 pulls the ball down): aim mid/high so the dip reads.
      if (t.y < 1.1) t.y = rand(rng, 1.25, 1.9)
      omega.x = rand(rng, 26, 38) * level.curve
      omega.y *= 0.3
      flightTime *= 1.08
      break
    case 'skimmer':
      // Low and quick along the grass.
      t.y = rand(rng, 0.17, 0.3)
      omega.x = -rand(rng, 2, 5)
      omega.y *= 0.25
      flightTime *= 0.92
      break
    case 'topCorner': {
      const side = Math.abs(t.x) > 0.3 ? Math.sign(t.x) : rng() < 0.5 ? -1 : 1
      t.x = side * rand(rng, GOAL_HALF_WIDTH - 0.62, GOAL_HALF_WIDTH - 0.42)
      t.y = rand(rng, 1.98, 2.14)
      spreadTarget(t, 0.6 + 0.4 * level.spread)
      omega.y = side * rand(rng, 14, 24) * level.curve
      omega.x *= 0.3
      flightTime *= 1.05
      break
    }
  }

  const zone = zoneOf(t.x, t.y)
  const tell = tellOf(t.x, zone)
  let fake: StrikerTell | null = null
  if (tell.side !== 0 && rng() < level.fake) fake = { side: tell.side === 1 ? -1 : 1, high: tell.high }

  return { zone, target: t, omega, flightTime, tell, shot, fake, fakeUntil: fake ? 0.45 : 0 }
}

/** Tell to show at wind-up progress p (0..1): the feint first, then the real one. */
export function tellAt(plan: Pick<ShotPlan, 'tell' | 'fake' | 'fakeUntil'>, p: number): StrikerTell {
  return plan.fake && p < plan.fakeUntil ? plan.fake : plan.tell
}

// ---------- guided practice ----------

export const PRACTICE_KICKS = 3
/** Practice balls fly this much slower than a normal kick 0. */
export const PRACTICE_SPEED = 0.6
/** Left, right, then a high centre ball (so the third arrow shows the "high" colour). */
const PRACTICE_TARGETS: readonly { x: number; y: number }[] = [
  { x: -2.1, y: 1.15 },
  { x: 2.1, y: 1.15 },
  { x: 0, y: 1.95 },
]

/** Fixed, slow, spin-free practice shot `i` (0..PRACTICE_KICKS-1). Same every time, no fakes. */
export function planPracticeShot(i: number): ShotPlan {
  const p = PRACTICE_TARGETS[Math.max(0, Math.min(PRACTICE_TARGETS.length - 1, Math.floor(i)))]
  const zone = zoneOf(p.x, p.y)
  return {
    zone,
    target: { x: p.x, y: p.y, z: 0 },
    omega: { x: 0, y: 0, z: 0 },
    flightTime: 0.95 / PRACTICE_SPEED,
    tell: tellOf(p.x, zone),
    shot: 'straight',
    fake: null,
    fakeUntil: 0,
  }
}
