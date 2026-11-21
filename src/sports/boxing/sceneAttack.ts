// Drone attack choreography: a wind-up pose per pattern that reads during the 600 ms charge, then its own lunge.
import type { AttackPattern } from './types.ts'

const POSE_KEYS = [
  'x', 'y', 'z', 'pitch', 'yaw', 'roll',
  'leadX', 'leadY', 'leadZ', 'rearX', 'rearY', 'rearZ',
  'core', 'ringX', 'ringY', 'ringZ', 'ringPitch', 'ringYaw', 'ringSize',
] as const
type PoseKey = (typeof POSE_KEYS)[number]

/**
 * Offsets from the hover pose, metres and radians. pitch > 0 leans toward the player; roll > 0 lifts the lead side.
 * lead/rear: pod offsets with x pointing outward (lead is the hooking pod; both pods move alike otherwise).
 * core: chest orb depth (negative pulls it into the hull). ring*: telegraph ring placement, tilt and size change.
 */
export type AttackPose = Record<PoseKey, number>

/** These flip sign with the hook side. */
const MIRRORED: ReadonlySet<PoseKey> = new Set(['x', 'yaw', 'roll', 'ringX', 'ringYaw'])

const POSES: Record<AttackPattern, { wind: Partial<AttackPose>; strike: Partial<AttackPose> }> = {
  // The core pulls back into the hull while the ring charges straight at the player.
  straight: {
    wind: { y: 0.03, z: -0.3, pitch: -0.16, leadX: -0.08, leadZ: -0.12, rearX: -0.08, rearZ: -0.12, core: -0.07, ringZ: 0.42, ringSize: -0.12 },
    strike: { z: 1.15, pitch: 0.32, leadX: -0.1, leadZ: 0.28, rearX: -0.1, rearZ: 0.28, core: 0.08 },
  },
  // One pod lifts to head height and swings wide and back, the body winds up and the ring tilts toward that side.
  hook: {
    wind: { x: -0.1, y: 0.08, z: -0.08, yaw: 0.6, roll: 0.12, leadX: 0.34, leadY: 0.3, leadZ: -0.2, ringX: 0.28, ringYaw: 0.95 },
    strike: { x: 0.08, y: 0.1, z: 0.85, yaw: -0.85, roll: 0.1, leadX: 0.16, leadY: 0.4, leadZ: 0.3 },
  },
  // The drone rises with both pods overhead and the ring flips into a halo, then it smashes down.
  slam: {
    wind: { y: 0.32, z: -0.06, pitch: -0.38, leadX: -0.12, leadY: 0.24, leadZ: -0.06, rearX: -0.12, rearY: 0.24, rearZ: -0.06, ringY: 0.42, ringZ: 0.1, ringPitch: 1.15, ringSize: -0.35 },
    strike: { y: -0.12, z: 0.95, pitch: 0.72, leadX: -0.1, leadY: -0.08, leadZ: 0.3, rearX: -0.1, rearY: -0.08, rearZ: 0.3 },
  },
}

/** Scene ms from telegraph start to the full wind-up pose (the rest of the charge trembles). */
export const WIND_MS = 260

/** Lunge in (contact lands at inMs) and recover. */
export const STRIKE_TIMING: Record<AttackPattern, { inMs: number; backMs: number }> = {
  straight: { inMs: 110, backMs: 260 },
  hook: { inMs: 150, backMs: 300 },
  slam: { inMs: 140, backMs: 320 },
}

export const createPose = (): AttackPose => Object.fromEntries(POSE_KEYS.map((k) => [k, 0])) as AttackPose

/** out = wind-up pose * wind + strike pose * lunge. side: -1 hooks from screen left, 1 from screen right. */
export function blendAttackPose(pattern: AttackPattern, side: number, wind: number, lunge: number, out: AttackPose): AttackPose {
  const { wind: w, strike: s } = POSES[pattern]
  for (const k of POSE_KEYS) {
    const v = (w[k] ?? 0) * wind + (s[k] ?? 0) * lunge
    out[k] = MIRRORED.has(k) ? v * side : v
  }
  return out
}
