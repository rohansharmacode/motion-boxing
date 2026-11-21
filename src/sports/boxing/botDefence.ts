// Bot defence: it raises its guard and sways or ducks, with a readable tell first, and never reads a
// punch before it is thrown. It only reacts to what a human opponent could see: how hard the player
// has been pressing, and the punches already thrown. Time comes only from dtMs; randomness from deps.
import { BOT_GUARD, createGuardMeter, type GuardMeter } from './guard.ts'
import type { PunchKind } from './types.ts'

export type BotDodge = 'sway-left' | 'sway-right' | 'duck'

/** What the scene draws. tell: the bot is about to move and can still be hit; active: it has moved. */
export interface BotStance {
  guard: 'down' | 'raising' | 'up'
  dodge: BotDodge | null
  dodgePhase: 'tell' | 'active' | 'recover' | null
  broken: boolean
}

/** How a player punch meets the bot's defence. */
export type BotDefenceResult =
  | { kind: 'open' }
  /** The punch went into the guard. broke: this punch broke it. */
  | { kind: 'blocked'; broke: boolean }
  /** The bot moved out of the way. */
  | { kind: 'evaded'; dodge: BotDodge }
  /** The right punch for that dodge: it lands as a counter. */
  | { kind: 'caught'; dodge: BotDodge }

export const BOT_DEFENCE = {
  /** How often the bot considers raising its guard. */
  decideEveryMs: 450,
  /** Base chance per decision, plus per recent player punch, capped. */
  guardBase: 0.08,
  guardPerPressure: 0.06,
  guardMax: 0.45,
  /** Guard takes this long to come up; punches in this time land. */
  guardRaiseMs: 160,
  guardHoldMinMs: 700,
  guardHoldMaxMs: 1400,
  /** Guaranteed opening after the guard drops. */
  guardCooldownMs: 650,
  /** Chance to start a dodge after a player punch, plus per repeat of the same punch and per pressure. */
  dodgeBase: 0.1,
  dodgePerRepeat: 0.06,
  dodgePerPressure: 0.03,
  dodgeMax: 0.42,
  /** Tell before the move (the bot is still hittable), time out of line, time back. */
  tellMs: 220,
  activeMs: 450,
  recoverMs: 200,
  dodgeCooldownMs: 1300,
  /** Window for "recent" punches. */
  pressureWindowMs: 2000,
  /** Guard stamina cost per blocked punch. */
  blockCost: { jab: 9, cross: 13, hook: 17, uppercut: 22 } as Record<PunchKind, number>,
} as const

/** Sways are beaten by hooks (they wrap around), ducks by uppercuts. Everything else whiffs. */
export function catchesDodge(dodge: BotDodge, kind: PunchKind): boolean {
  return dodge === 'duck' ? kind === 'uppercut' : kind === 'hook'
}

export interface BotDefence {
  readonly stance: BotStance
  readonly guard: GuardMeter
  /** False while the bot is busy attacking or stunned: no guard, no dodges. */
  setBusy(busy: boolean): void
  /**
   * Resolve a player punch thrown now. Call once per punch, before damage.
   * onTarget: the glove was aimed at the bot; a wild miss never drains the guard.
   */
  onPunch(kind: PunchKind, nowMs: number, onTarget?: boolean): BotDefenceResult
  update(dtMs: number, nowMs: number): void
  reset(): void
}

export function createBotDefence(random: () => number = Math.random): BotDefence {
  const cfg = BOT_DEFENCE
  const meter = createGuardMeter(BOT_GUARD)
  let busy = false
  let guardState: BotStance['guard'] = 'down'
  let guardMs = 0
  let guardHoldMs = 0
  let guardCooldown = 0
  let decideAcc = 0
  let dodge: BotDodge | null = null
  let dodgePhase: BotStance['dodgePhase'] = null
  let dodgeMs = 0
  let dodgeCooldown = 0
  let recent: { kind: PunchKind; t: number }[] = []
  let lastSide: 'sway-left' | 'sway-right' = 'sway-right'

  const pressure = (now: number): number => recent.filter((p) => now - p.t <= cfg.pressureWindowMs).length

  function dropGuard(): void {
    if (guardState !== 'down') guardCooldown = cfg.guardCooldownMs
    guardState = 'down'
    guardMs = 0
  }

  function clearDodge(): void {
    dodge = null
    dodgePhase = null
    dodgeMs = 0
  }

  function pickDodge(kind: PunchKind): BotDodge {
    // Duck under hooks, sway off straights and uppercuts, like a person would.
    if (kind === 'hook') return 'duck'
    if (kind === 'uppercut' || random() < 0.7) {
      lastSide = lastSide === 'sway-left' ? 'sway-right' : 'sway-left'
      return lastSide
    }
    return 'duck'
  }

  function maybeDodge(kind: PunchKind, now: number): void {
    if (busy || meter.broken || dodge || dodgeCooldown > 0 || guardState !== 'down') return
    let repeats = 0
    for (let i = recent.length - 1; i >= 0 && recent[i].kind === kind; i--) repeats++
    const p = Math.min(
      cfg.dodgeMax,
      cfg.dodgeBase + cfg.dodgePerRepeat * Math.max(0, repeats - 1) + cfg.dodgePerPressure * pressure(now),
    )
    if (random() >= p) return
    dodge = pickDodge(kind)
    dodgePhase = 'tell'
    dodgeMs = 0
  }

  const api: BotDefence = {
    get stance() {
      return { guard: guardState, dodge, dodgePhase, broken: meter.broken }
    },
    guard: meter,

    setBusy(b) {
      busy = b
      if (b) {
        dropGuard()
        if (dodgePhase === 'tell') clearDodge()
      }
    },

    onPunch(kind, now, onTarget = true) {
      let result: BotDefenceResult = { kind: 'open' }
      if (dodge && dodgePhase === 'active') {
        result = catchesDodge(dodge, kind) ? { kind: 'caught', dodge } : { kind: 'evaded', dodge }
      } else if (onTarget && guardState === 'up' && meter.canBlock) {
        const broke = meter.block(cfg.blockCost[kind]) === 'broke'
        if (broke) {
          guardState = 'down'
          guardMs = 0
          clearDodge()
        }
        result = { kind: 'blocked', broke }
      }
      // The bot sees this punch now; it can only react to the next ones.
      recent.push({ kind, t: now })
      if (recent.length > 12) recent = recent.slice(-12)
      if (result.kind === 'open' && onTarget) maybeDodge(kind, now)
      return result
    },

    update(dtMs, now) {
      const dt = Math.max(0, dtMs)
      meter.update(dt, guardState === 'up')
      if (dodgeCooldown > 0) dodgeCooldown = Math.max(0, dodgeCooldown - dt)
      if (guardCooldown > 0) guardCooldown = Math.max(0, guardCooldown - dt)
      if (meter.broken) {
        guardState = 'down'
        clearDodge()
        return
      }

      if (dodge) {
        dodgeMs += dt
        if (dodgePhase === 'tell' && dodgeMs >= cfg.tellMs) {
          dodgePhase = 'active'
          dodgeMs = 0
        } else if (dodgePhase === 'active' && dodgeMs >= cfg.activeMs) {
          dodgePhase = 'recover'
          dodgeMs = 0
        } else if (dodgePhase === 'recover' && dodgeMs >= cfg.recoverMs) {
          clearDodge()
          dodgeCooldown = cfg.dodgeCooldownMs
        }
        return
      }

      if (guardState !== 'down') {
        guardMs += dt
        if (guardState === 'raising' && guardMs >= cfg.guardRaiseMs) guardState = 'up'
        if (guardMs >= guardHoldMs || busy) dropGuard()
        return
      }

      if (busy || guardCooldown > 0) return
      decideAcc += dt
      if (decideAcc < cfg.decideEveryMs) return
      decideAcc %= cfg.decideEveryMs
      const p = Math.min(cfg.guardMax, cfg.guardBase + cfg.guardPerPressure * pressure(now))
      if (random() < p) {
        guardState = 'raising'
        guardMs = 0
        guardHoldMs = cfg.guardHoldMinMs + (cfg.guardHoldMaxMs - cfg.guardHoldMinMs) * random()
      }
    },

    reset() {
      meter.reset()
      busy = false
      guardState = 'down'
      guardMs = guardHoldMs = guardCooldown = decideAcc = 0
      clearDodge()
      dodgeCooldown = 0
      recent = []
    },
  }
  return api
}
