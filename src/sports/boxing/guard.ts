// Guard stamina for one fighter. Blocking drains it, it refills after a short rest, and at 0 the guard
// breaks: a stun window where the guard does nothing, then the meter comes back part full.
// Time comes only from dtMs so rounds stay deterministic.

export interface GuardConfig {
  /** Full meter. */
  max: number
  /** Points per second refilled once regenDelayMs has passed since the last block. */
  regenPerSec: number
  /** Rest after a block before the meter refills. */
  regenDelayMs: number
  /** Regen multiplier while the guard is held (blocking is tiring). */
  heldRegenFactor: number
  /** Stun length after a guard break. */
  breakMs: number
  /** Meter value when the stun ends, as a fraction of max. */
  recoverFraction: number
}

export const PLAYER_GUARD: GuardConfig = {
  max: 100,
  regenPerSec: 14,
  regenDelayMs: 1200,
  heldRegenFactor: 0.4,
  breakMs: 1600,
  recoverFraction: 0.5,
}

export const BOT_GUARD: GuardConfig = {
  max: 100,
  regenPerSec: 12,
  regenDelayMs: 1400,
  heldRegenFactor: 0.5,
  breakMs: 2200,
  recoverFraction: 0.5,
}

export type BlockOutcome = 'blocked' | 'broke'

export interface GuardMeter {
  /** 0 to max. */
  readonly value: number
  /** value / max, 0 to 1. */
  readonly fraction: number
  /** True during the stun after a break. */
  readonly broken: boolean
  /** ms of stun left, 0 when not broken. */
  readonly brokenMs: number
  /** Can this fighter block right now? */
  readonly canBlock: boolean
  /** Take a blocked hit of cost points. Returns 'broke' when this hit emptied the meter. */
  block(cost: number): BlockOutcome
  /** Advance time. held: guard is up this step. */
  update(dtMs: number, held: boolean): void
  reset(): void
}

export function createGuardMeter(config: GuardConfig = PLAYER_GUARD): GuardMeter {
  let value = config.max
  let brokenMs = 0
  let restMs = 0

  return {
    get value() {
      return value
    },
    get fraction() {
      return value / config.max
    },
    get broken() {
      return brokenMs > 0
    },
    get brokenMs() {
      return brokenMs
    },
    get canBlock() {
      return brokenMs === 0 && value > 0
    },

    block(cost) {
      if (brokenMs > 0) return 'broke'
      value = Math.max(0, value - Math.max(0, cost))
      restMs = config.regenDelayMs
      if (value > 0) return 'blocked'
      brokenMs = config.breakMs
      return 'broke'
    },

    update(dtMs, held) {
      let dt = Math.max(0, dtMs)
      if (brokenMs > 0) {
        brokenMs = Math.max(0, brokenMs - dt)
        if (brokenMs === 0) {
          value = config.max * config.recoverFraction
          restMs = 0
        }
        return
      }
      if (restMs > 0) {
        const used = Math.min(restMs, dt)
        restMs -= used
        dt -= used
        if (dt <= 0) return
      }
      const rate = config.regenPerSec * (held ? config.heldRegenFactor : 1)
      value = Math.min(config.max, value + (rate * dt) / 1000)
    },

    reset() {
      value = config.max
      brokenMs = 0
      restMs = 0
    },
  }
}
