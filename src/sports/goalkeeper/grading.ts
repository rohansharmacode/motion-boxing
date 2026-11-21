// Save grading, combo multiplier, round score and the results grade for Reflex Keeper. Pure.
//
// A save's quality mixes how centred the hand met the ball (engine accuracy, 0..100, from the
// hand-to-ball offset at contact) with timing (how soon after the wind-up began the keeper moved).

import type { KeeperPart } from './types.ts'

export type SaveGrade = 'perfect' | 'good' | 'fingertip' | 'miss'
export type ResultGrade = 'S' | 'A' | 'B' | 'C'

export interface GradeInput {
  outcome: 'save' | 'goal'
  /** null on a save means the shot went wide (no keeper contact). */
  part: KeeperPart | null
  /** 0..100 hand-to-ball centredness. */
  accuracy: number
  /** ms from the start of the wind-up to the first decisive move, null if none was detected. */
  reactionMs: number | null
}

/** Reaction at or under this is full marks for timing. */
export const TIMING_BEST_MS = 450
/** Reaction at or over this scores zero for timing. */
export const TIMING_WORST_MS = 1100
/** Timing credit when no reaction was measured (the gloves were already there). */
export const TIMING_UNKNOWN = 0.4
export const ACCURACY_WEIGHT = 0.7

export const PERFECT_AT = 0.72
export const GOOD_AT = 0.45

export const GRADE_POINTS: Readonly<Record<SaveGrade, number>> = { perfect: 1500, good: 1000, fingertip: 600, miss: 0 }
export const PUNCH_BONUS = 150
export const COMBO_STEP = 0.25
export const COMBO_MAX = 2

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

/** 1 for a fast reaction, 0 for a very late one, TIMING_UNKNOWN when unmeasured. */
export function timingScore(reactionMs: number | null): number {
  if (reactionMs === null || !Number.isFinite(reactionMs)) return TIMING_UNKNOWN
  return clamp01((TIMING_WORST_MS - reactionMs) / (TIMING_WORST_MS - TIMING_BEST_MS))
}

/** 0..1 save quality. */
export function saveQuality(input: Pick<GradeInput, 'accuracy' | 'reactionMs'>): number {
  const acc = clamp01((Number.isFinite(input.accuracy) ? input.accuracy : 0) / 100)
  return ACCURACY_WEIGHT * acc + (1 - ACCURACY_WEIGHT) * timingScore(input.reactionMs)
}

/** Grade one kick. null for a wide shot (no contact, no goal): it neither builds nor breaks a combo. */
export function gradeSave(input: GradeInput): SaveGrade | null {
  if (input.outcome === 'goal') return 'miss'
  if (input.part === null) return null
  const q = saveQuality(input)
  // A body block is solid but never a highlight-reel save.
  if (q >= PERFECT_AT && input.part !== 'torso') return 'perfect'
  if (q >= GOOD_AT) return 'good'
  return 'fingertip'
}

/** Combo after this kick: saves add one, a goal resets, a wide shot leaves it unchanged. */
export function nextCombo(prev: number, grade: SaveGrade | null): number {
  if (grade === null) return prev
  if (grade === 'miss') return 0
  return prev + 1
}

/** Score multiplier for a combo count: x1, x1.25, x1.5 ... capped at COMBO_MAX. */
export function comboMultiplier(combo: number): number {
  if (!(combo > 1)) return 1
  return Math.min(COMBO_MAX, 1 + COMBO_STEP * (combo - 1))
}

/** Points for one kick at a combo count (the combo including this kick). */
export function kickPoints(grade: SaveGrade | null, combo: number, punch = false): number {
  if (grade === null || grade === 'miss') return 0
  return Math.round(GRADE_POINTS[grade] * comboMultiplier(combo) + (punch ? PUNCH_BONUS : 0))
}

export interface GradedKick {
  grade: SaveGrade | null
  punch?: boolean
}

export interface ScoreSummary {
  score: number
  bestCombo: number
  perfects: number
  goods: number
  fingertips: number
  misses: number
}

/** Replay a round's grades in order. */
export function scoreKicks(kicks: readonly GradedKick[]): ScoreSummary {
  const s: ScoreSummary = { score: 0, bestCombo: 0, perfects: 0, goods: 0, fingertips: 0, misses: 0 }
  let combo = 0
  for (const k of kicks) {
    combo = nextCombo(combo, k.grade)
    if (combo > s.bestCombo) s.bestCombo = combo
    s.score += kickPoints(k.grade, combo, k.punch === true)
    if (k.grade === 'perfect') s.perfects++
    else if (k.grade === 'good') s.goods++
    else if (k.grade === 'fingertip') s.fingertips++
    else if (k.grade === 'miss') s.misses++
  }
  return s
}

/** Best possible score for `kicks` shots: every one perfect, combo growing (punch bonus excluded). */
export function maxScore(kicks: number): number {
  let total = 0
  for (let c = 1; c <= kicks; c++) total += GRADE_POINTS.perfect * comboMultiplier(c)
  return Math.round(total)
}

/**
 * Results grade. S: every shot stopped and at least 75% of the best possible score.
 * A: 80%+ saves. B: 60%+ saves. C: below that.
 */
export function resultGrade(saves: number, total: number, score: number): ResultGrade {
  if (total <= 0) return 'C'
  const pct = saves / total
  if (saves >= total && score >= 0.75 * maxScore(total)) return 'S'
  if (pct >= 0.8) return 'A'
  if (pct >= 0.6) return 'B'
  return 'C'
}
