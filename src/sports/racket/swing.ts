// Racket swing detector (table tennis, tennis). Pure: no DOM, time comes only from BodyFrame.t. Moved out of
// racket/index.ts unchanged so the motion lab (/record.html) can replay and tune it; the game uses it the same way.
// The hitting hand is whichever wrist moves fastest (above handSwitchSpeed). A swing fires when that speed passes
// swingMinSpeed, at most once per cooldownMs. Speeds are 2D body space: shoulder widths per second (SW/s).
import type { OneEuroParams } from '../../pose/oneEuro.ts'
import { LM } from '../../pose/types.ts'
import type { BodyFrame, Hand } from '../../pose/types.ts'

/** Tracker smoothing used by the racket sports (createBodyTracker). */
export const RACKET_TRACKER_FILTER: OneEuroParams = { minCutoff: 1.8, beta: 0.25, dCutoff: 1.5 }

export interface SwingConfig {
  /** 0 to 1. Wrists below this visibility are ignored. */
  minVisibility: number
  /** s. A longer gap between frames gives no speed for that frame. */
  maxGapS: number
  /** SW/s. The hitting hand switches to a wrist moving faster than this. */
  handSwitchSpeed: number
  /** SW/s. A swing fires above this wrist speed. */
  swingMinSpeed: number
  /** ms. Minimum time between two swings. */
  cooldownMs: number
  /** SW/s. Power is (speed - powerFloor) / powerRange, clamped to 0..1. */
  powerFloor: number
  powerRange: number
}

export const DEFAULT_SWING_CONFIG: SwingConfig = {
  minVisibility: 0.3,
  maxGapS: 0.2,
  handSwitchSpeed: 3,
  swingMinSpeed: 4.5,
  cooldownMs: 350,
  powerFloor: 3,
  powerRange: 9,
}

export interface SwingEvent {
  t: number
  hand: Hand
  /** 0..1 */
  power: number
  /** -1..1: sideways share of the swing direction (screen x). */
  aim: number
  /** SW/s */
  speed: number
}

export interface SwingSample {
  /** Current hitting hand. */
  hand: Hand
  /** Body-space x of the hitting hand's wrist. */
  handX: number
  /** Fastest wrist speed this frame, SW/s (0 when none). */
  speed: number
  /** Power the live meter shows this frame (can be negative below powerFloor; the game clamps it with max). */
  livePower: number
  swing: SwingEvent | null
}

export interface SwingDetector {
  push(b: BodyFrame): SwingSample
  reset(): void
}

export function createSwingDetector(config: Partial<SwingConfig> = {}): SwingDetector {
  const c: SwingConfig = { ...DEFAULT_SWING_CONFIG, ...config }
  let lastW: Record<Hand, { x: number; y: number; t: number } | null> = { left: null, right: null }
  let hand: Hand = 'right'
  let lastSwingT = 0

  return {
    push(b) {
      let best = 0
      let bestV = { x: 0, y: 0 }
      for (const side of ['left', 'right'] as const) {
        const w = b.body[side === 'left' ? LM.L_WRIST : LM.R_WRIST]
        const prev = lastW[side]
        lastW[side] = { x: w.x, y: w.y, t: b.t }
        if (!prev || w.visibility < c.minVisibility) continue
        const dt = (b.t - prev.t) / 1000
        if (dt <= 0 || dt > c.maxGapS) continue
        const vx = (w.x - prev.x) / dt
        const vy = (w.y - prev.y) / dt
        const sp = Math.hypot(vx, vy)
        if (sp > best) {
          best = sp
          bestV = { x: vx, y: vy }
          if (sp > c.handSwitchSpeed) hand = side
        }
      }
      const w = b.body[hand === 'left' ? LM.L_WRIST : LM.R_WRIST]
      const power = Math.min(1, (best - c.powerFloor) / c.powerRange)
      let swing: SwingEvent | null = null
      if (best > c.swingMinSpeed && b.t - lastSwingT > c.cooldownMs) {
        lastSwingT = b.t
        swing = { t: b.t, hand, power, aim: Math.max(-1, Math.min(1, bestV.x / Math.max(best, 1))), speed: best }
      }
      return { hand, handX: w.x, speed: best, livePower: power, swing }
    },
    reset() {
      lastW = { left: null, right: null }
      hand = 'right'
      lastSwingT = 0
    },
  }
}
