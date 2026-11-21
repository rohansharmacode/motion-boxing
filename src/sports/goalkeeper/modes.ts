// Round modes for Reflex Keeper: classic 5-kick shootout, sudden death (first goal ends it), the seeded
// daily challenge (10 fixed shots, own high score), and the guided practice. Plus the kickoff countdown
// and the per-round best reaction. Pure apart from the small localStorage helpers at the bottom.

import { DIFFICULTY_PARAMS } from './difficulty.ts'
import { planShot } from './shots.ts'
import type { ShotPlan } from './shots.ts'
import { mulberry32 } from './striker.ts'
import type { KickResult, Zone } from './types.ts'
import { KICKS_PER_SHOOTOUT } from './types.ts'

export type RoundMode = 'classic' | 'sudden' | 'daily' | 'practice'

export const DAILY_KICKS = 10
/** Safety cap so a sudden-death streak cannot run forever. */
export const SUDDEN_MAX_KICKS = 30
export const PRACTICE_ROUND_KICKS = 3
/** Daily shots speed up by kick number (not by saves) so every player faces the same 10 shots. */
export const DAILY_SPEED_STEP = 0.035

/** Planned number of kicks, or null for open-ended sudden death. */
export function plannedKicks(mode: RoundMode): number | null {
  switch (mode) {
    case 'classic':
      return KICKS_PER_SHOOTOUT
    case 'daily':
      return DAILY_KICKS
    case 'practice':
      return PRACTICE_ROUND_KICKS
    case 'sudden':
      return null
  }
}

/** True once the round is over after `results` (in kick order). */
export function roundOver(mode: RoundMode, results: readonly Pick<KickResult, 'outcome'>[]): boolean {
  const n = results.length
  if (mode === 'sudden') return n >= SUDDEN_MAX_KICKS || (n > 0 && results[n - 1].outcome === 'goal')
  return n >= (plannedKicks(mode) ?? 0)
}

// ---------- daily challenge ----------

/** Local calendar date as YYYY-MM-DD (the daily key). */
export function dailyKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Seed from a daily key (FNV-1a), stable across browsers. */
export function dailySeed(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** The day's 10 shots, generated up front so player outcomes cannot change them. */
export function planDailyRound(seed: number): ShotPlan[] {
  const rng = mulberry32(seed)
  const level = DIFFICULTY_PARAMS.normal
  const zones: Zone[] = []
  const plans: ShotPlan[] = []
  for (let i = 0; i < DAILY_KICKS; i++) {
    const plan = planShot(Math.min(i, 4), rng, zones, level, level.speed * (1 + DAILY_SPEED_STEP * i))
    zones.push(plan.zone)
    plans.push(plan)
  }
  return plans
}

// ---------- kickoff countdown ----------

export const COUNTDOWN_LABELS: readonly string[] = ['3', '2', '1', 'GO!']
export const COUNTDOWN_STEP_MS = 600
export const COUNTDOWN_MS = COUNTDOWN_LABELS.length * COUNTDOWN_STEP_MS

/** Label to show `elapsedMs` into the countdown, or null once it is over. */
export function countdownLabel(elapsedMs: number): string | null {
  if (!(elapsedMs >= 0)) return COUNTDOWN_LABELS[0]
  const i = Math.floor(elapsedMs / COUNTDOWN_STEP_MS)
  return i < COUNTDOWN_LABELS.length ? COUNTDOWN_LABELS[i] : null
}

// ---------- stats ----------

/** Sudden-death grade from the streak (the round always ends on a goal, so save % cannot be used). */
export const SUDDEN_GRADE_AT: Readonly<Record<'S' | 'A' | 'B', number>> = { S: 10, A: 6, B: 3 }

export function suddenGrade(streak: number): 'S' | 'A' | 'B' | 'C' {
  if (streak >= SUDDEN_GRADE_AT.S) return 'S'
  if (streak >= SUDDEN_GRADE_AT.A) return 'A'
  if (streak >= SUDDEN_GRADE_AT.B) return 'B'
  return 'C'
}

/** Fastest reaction (ms) among real saves this round; null when no save had a measured reaction. */
export function bestReaction(kicks: readonly Pick<KickResult, 'outcome' | 'part' | 'reactionMs'>[]): number | null {
  let best: number | null = null
  for (const k of kicks) {
    if (k.outcome !== 'save' || k.part === null || k.reactionMs === null) continue
    if (best === null || k.reactionMs < best) best = k.reactionMs
  }
  return best
}

// ---------- daily high score (localStorage) ----------

const DAILY_BEST_PREFIX = 'gk.daily.best.'

export function loadDailyBest(key: string, storage: Pick<Storage, 'getItem'> | null = safeStorage()): number | null {
  try {
    const v = storage?.getItem(DAILY_BEST_PREFIX + key)
    const n = v == null ? Number.NaN : Number(v)
    return Number.isFinite(n) && n >= 0 ? n : null
  } catch {
    return null
  }
}

/** Store `score` if it beats today's best. Returns true when it is a new best. */
export function saveDailyBest(key: string, score: number, storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): boolean {
  if (!Number.isFinite(score) || score < 0) return false
  const prev = loadDailyBest(key, storage)
  if (prev !== null && score <= prev) return false
  try {
    storage?.setItem(DAILY_BEST_PREFIX + key, String(Math.round(score)))
    return storage !== null
  } catch {
    return false
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
