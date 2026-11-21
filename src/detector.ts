// Punch and block detector. Pure: no DOM, time comes only from PoseFrame.t.
// Units: S = shoulder width (3D distance between the shoulders in world metres).
// Distances are in S and speeds in S per second, so results do not depend on camera distance.
import type { Detector, DetectorOutput, Hand, Landmark, PoseFrame, PunchEvent, PunchType } from './types.ts'
import { LM } from './types.ts'

export interface DetectorConfig {
  /** Minimum visibility (0 to 1) of a wrist and its shoulder for the hand to be tracked. */
  minVisibility: number
  /** Raw shoulder widths below this (metres) are ignored as broken tracking. */
  minShoulderWidth: number
  /** Time constant (ms) of the shoulder width smoothing. */
  shoulderSmoothMs: number
  /** Velocity window (ms). The newest sample before the window is kept too. */
  velocityWindowMs: number
  /** Minimum time span (ms) of the samples before a velocity is trusted. */
  minVelocitySpanMs: number
  /** A gap between frames longer than this (ms) clears motion history. */
  maxGapMs: number
  /** Jab: minimum extension speed (S/s). */
  jabSpeed: number
  /** Jab: minimum extension (S) reached while the speed is above jabSpeed. */
  jabMinReach: number
  /** Jab: forward speed must exceed this ratio times the inward and the sideways speed. */
  jabForwardRatio: number
  /** Jab: forward speed must exceed this ratio times the vertical speed. */
  jabVerticalRatio: number
  /** Hook: minimum inward speed (S/s). */
  hookSpeed: number
  /** Hook: maximum |wrist y - shoulder y| (S). */
  hookMaxHeight: number
  /** Hook: inward speed must exceed this ratio times the forward speed. */
  hookInwardRatio: number
  /** Lockout: minimum time (ms) after a punch before the same hand can punch again. */
  cooldownMs: number
  /** Lockout: after the cooldown, re-arm when extension (S) is below this... */
  rearmReach: number
  /** ...or when wrist speed (S/s) is below this. */
  rearmSpeed: number
  /** Block: wrists may be at most this far (S) below the nose. */
  blockMaxBelowNose: number
  /** Block: wrists may be at most this far (S) from the nose horizontally. */
  blockMaxSideDist: number
  /** Block: both wrists must be slower than this (S/s). Faster ends the block at once. */
  blockMaxSpeed: number
  /** Block: time (ms) the block pose must be held before blocking turns true. */
  blockHoldMs: number
  /** Block: time (ms) out of position before a held block is released. */
  blockReleaseMs: number
}

// Reference body (S = 0.38 m): guard extension 0.6, jab peak 1.6 at 6 to 9 S/s, hook inward
// about 7 S/s. Slow (1.2 s) versions peak near 1.5 S/s. Idle jitter of 0.01 m gives speeds well
// under 1 S/s. Thresholds sit between these with a margin of about 2x on each side.
export const DEFAULT_CONFIG: DetectorConfig = {
  minVisibility: 0.5,
  minShoulderWidth: 0.05,
  shoulderSmoothMs: 200,
  velocityWindowMs: 70, // with the extra older sample: 70 to 90 ms at 60 fps, 67 to 133 ms at 15 fps
  minVelocitySpanMs: 40, // never trust a single 60 fps frame pair
  maxGapMs: 250,
  jabSpeed: 2.5, // a jab with depth compressed to 60% still averages about 3.6 S/s
  jabMinReach: 0.95, // guard is 0.6; a compressed real jab still reaches about 1.0
  jabForwardRatio: 1.5, // reference jab: about 5x
  jabVerticalRatio: 1, // lets a jab from a high block (forward and down) count, stops fast block raises
  hookSpeed: 3, // reference 7 S/s, slow version 1.5 S/s, a straight cross about 2 S/s
  hookMaxHeight: 0.6,
  hookInwardRatio: 1.5, // reference hook: about 9x
  cooldownMs: 350,
  rearmReach: 0.8, // between guard (0.6) and the jab reach
  rearmSpeed: 1.5,
  blockMaxBelowNose: 0.15, // guard wrists sit about 0.3 S below the nose, block wrists above it
  blockMaxSideDist: 0.6,
  blockMaxSpeed: 2, // above jitter, below any punch
  blockHoldMs: 250,
  blockReleaseMs: 150,
}

interface Sample { t: number; x: number; y: number; z: number; e: number }

/** Windowed velocity of one hand, all in S/s. */
interface Velocity {
  ext: number
  inward: number
  forward: number
  side: number
  vertical: number
  speed: number
}

interface HandState {
  readonly hand: Hand
  readonly wrist: number
  readonly shoulder: number
  readonly other: number
  hist: Sample[]
  tracked: boolean
  ext: number
  /** |wrist y - shoulder y| in S. */
  height: number
  vel: Velocity | null
  locked: boolean
  lastPunchT: number
}

function dist(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/** Least-squares slope of f over the samples, per second. Handles uneven frame spacing. */
function slope(h: Sample[], f: (s: Sample) => number): number {
  let mt = 0
  let mv = 0
  for (const s of h) { mt += s.t; mv += f(s) }
  mt /= h.length
  mv /= h.length
  let num = 0
  let den = 0
  for (const s of h) { num += (s.t - mt) * (f(s) - mv); den += (s.t - mt) ** 2 }
  return den > 0 ? (num / den) * 1000 : 0
}

function newHand(hand: Hand): HandState {
  const left = hand === 'left'
  return {
    hand,
    wrist: left ? LM.L_WRIST : LM.R_WRIST,
    shoulder: left ? LM.L_SHOULDER : LM.R_SHOULDER,
    other: left ? LM.R_SHOULDER : LM.L_SHOULDER,
    hist: [], tracked: false, ext: 0, height: 0, vel: null, locked: false, lastPunchT: 0,
  }
}

export function createDetector(config: Partial<DetectorConfig> = {}): Detector {
  const cfg: DetectorConfig = { ...DEFAULT_CONFIG, ...config }
  const hands = [newHand('left'), newHand('right')]
  let S = 0 // smoothed shoulder width in metres, 0 = unknown
  let lastT: number | null = null
  let blocking = false
  let holdStart: number | null = null
  let releaseStart: number | null = null

  function untrack(h: HandState): void {
    h.hist = []
    h.tracked = false
    h.ext = 0
    h.vel = null
  }

  function endBlock(): void {
    blocking = false
    holdStart = null
    releaseStart = null
  }

  /** Null frames and gaps: no velocity across them, no block. Lockouts stay. */
  function clearMotion(): void {
    hands.forEach(untrack)
    S = 0
    lastT = null
    endBlock()
  }

  function trackHand(h: HandState, w: Landmark[], t: number): void {
    const W = w[h.wrist]
    const P = w[h.shoulder]
    const Q = w[h.other]
    const e = dist(W, P) / S
    if (S <= 0 || W.visibility < cfg.minVisibility || P.visibility < cfg.minVisibility || !Number.isFinite(e)) {
      untrack(h)
      return
    }
    h.tracked = true
    h.ext = e
    h.height = Math.abs(W.y - P.y) / S
    h.hist.push({ t, x: W.x, y: W.y, z: W.z, e })
    while (h.hist.length > 2 && h.hist[1].t <= t - cfg.velocityWindowMs) h.hist.shift()
    h.vel = null
    if (t - h.hist[0].t >= cfg.minVelocitySpanMs) {
      const vx = slope(h.hist, (s) => s.x) / S
      const vy = slope(h.hist, (s) => s.y) / S
      const vz = slope(h.hist, (s) => s.z) / S
      // Inward: horizontal (x, z) unit vector from own shoulder toward the other one.
      // Independent of which shoulder has the larger x, so mirrored input behaves the same.
      const ix = Q.x - P.x
      const iz = Q.z - P.z
      const n = Math.hypot(ix, iz)
      h.vel = {
        ext: slope(h.hist, (s) => s.e),
        inward: n > 1e-6 ? (vx * ix + vz * iz) / n : 0,
        forward: -vz,
        side: Math.abs(vx),
        vertical: Math.abs(vy),
        speed: Math.hypot(vx, vy, vz),
      }
    }
    const back = h.ext < cfg.rearmReach || (h.vel !== null && h.vel.speed < cfg.rearmSpeed)
    if (h.locked && t - h.lastPunchT >= cfg.cooldownMs && back) h.locked = false
  }

  function updateBlock(w: Landmark[], t: number): void {
    const nose = w[LM.NOSE]
    const inPose = hands.every((h) => {
      const W = w[h.wrist]
      return h.tracked && W.y - nose.y <= cfg.blockMaxBelowNose * S && Math.abs(W.x - nose.x) <= cfg.blockMaxSideDist * S
    })
    const fast = hands.some((h) => h.vel !== null && h.vel.speed > cfg.blockMaxSpeed)
    if (blocking) {
      if (fast) endBlock()
      else if (inPose) releaseStart = null
      else {
        releaseStart ??= t
        if (t - releaseStart >= cfg.blockReleaseMs) endBlock()
      }
    } else if (inPose && !fast) {
      holdStart ??= t
      // Speeds must be known (not just "not fast") before the block turns on.
      if (t - holdStart >= cfg.blockHoldMs && hands.every((h) => h.vel !== null)) blocking = true
    } else holdStart = null
  }

  function detectPunch(h: HandState, t: number): PunchEvent | null {
    const v = h.vel
    if (h.locked || v === null) return null
    let type: PunchType | null = null
    // Both rules need a positive speed toward the target, so retraction never counts.
    if (v.ext > cfg.jabSpeed && h.ext >= cfg.jabMinReach &&
      v.forward > cfg.jabForwardRatio * Math.max(v.inward, v.side) &&
      v.forward > cfg.jabVerticalRatio * v.vertical) type = 'jab'
    else if (v.inward > cfg.hookSpeed && h.height <= cfg.hookMaxHeight &&
      v.inward > cfg.hookInwardRatio * v.forward) type = 'hook'
    if (type === null) return null
    h.locked = true
    h.lastPunchT = t
    return { type, hand: h.hand, t, speed: v.speed }
  }

  function debug(t: number): Record<string, number> {
    const d: Record<string, number> = { S }
    for (const h of hands) {
      const p = h.hand === 'left' ? 'l' : 'r'
      d[p + 'Ext'] = h.ext
      d[p + 'ExtSpeed'] = h.vel?.ext ?? 0
      d[p + 'Inward'] = h.vel?.inward ?? 0
      d[p + 'Forward'] = h.vel?.forward ?? 0
      d[p + 'Locked'] = h.locked ? 1 : 0
    }
    d.blockHold = holdStart === null ? 0 : t - holdStart
    d.blocking = blocking ? 1 : 0
    for (const k in d) if (!Number.isFinite(d[k])) d[k] = 0
    return d
  }

  return {
    update(frame: PoseFrame | null): DetectorOutput {
      const punches: PunchEvent[] = []
      if (frame === null || frame.world.length < 33) {
        clearMotion()
        return { punches, blocking, debug: debug(0) }
      }
      const t = frame.t
      if (lastT !== null && (t <= lastT || t - lastT > cfg.maxGapMs)) clearMotion()
      const w = frame.world
      const rawS = dist(w[LM.L_SHOULDER], w[LM.R_SHOULDER])
      if (rawS >= cfg.minShoulderWidth) {
        // lastT is not null when S > 0, and t > lastT, so dt > 0.
        S = S > 0 && lastT !== null ? S + (rawS - S) * (1 - Math.exp(-(t - lastT) / cfg.shoulderSmoothMs)) : rawS
      }
      lastT = t
      for (const h of hands) trackHand(h, w, t)
      updateBlock(w, t) // before punches: a fast wrist ends the block, so a punch from a block counts
      if (!blocking) {
        for (const h of hands) {
          const p = detectPunch(h, t)
          if (p) punches.push(p)
        }
      }
      return { punches, blocking, debug: debug(t) }
    },
    reset(): void {
      clearMotion()
      for (const h of hands) h.locked = false
    },
  }
}
