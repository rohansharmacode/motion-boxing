// Difficulty levels and the in-round auto-ramp for Reflex Keeper. Pure: no DOM, no Three.js.

export type Difficulty = 'easy' | 'normal' | 'hard'

export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard']

export interface DifficultyParams {
  /** Multiplies ball speed (divides flight time). 1 = the original tuning. */
  speed: number
  /** Multiplies sidespin and topspin (curve and dip). */
  curve: number
  /** Chance 0..1 that the wind-up arrow feints to the wrong side before switching. */
  fake: number
  /** 0..1: how far shots spread toward the posts and bar (0 = near the middle, 1 = full corners). */
  spread: number
  /** Relative weights of each shot type, see shots.ts. */
  mix: Readonly<Record<'straight' | 'curl' | 'dip' | 'skimmer' | 'topCorner', number>>
}

export const DIFFICULTY_PARAMS: Readonly<Record<Difficulty, DifficultyParams>> = {
  easy: {
    speed: 0.78,
    curve: 0.55,
    fake: 0,
    spread: 0.6,
    mix: { straight: 5, curl: 2, dip: 1, skimmer: 1, topCorner: 0.5 },
  },
  normal: {
    speed: 1,
    curve: 1,
    fake: 0.12,
    spread: 0.85,
    mix: { straight: 3, curl: 3, dip: 2, skimmer: 2, topCorner: 1.5 },
  },
  hard: {
    speed: 1.18,
    curve: 1.3,
    fake: 0.3,
    spread: 1,
    mix: { straight: 1.5, curl: 3, dip: 2.5, skimmer: 2, topCorner: 2.5 },
  },
}

/** Every RAMP_EVERY saves in a round the shots get faster. */
export const RAMP_EVERY = 3
/** Speed added per ramp step (multiplicative on top of the level's speed). */
export const RAMP_SPEED_STEP = 0.07
/** Ramp steps are capped so a long streak never becomes unplayable. */
export const RAMP_MAX_STEPS = 4

/** Ramp step reached after `saves` saves this round: 0, 1, 2 ... capped at RAMP_MAX_STEPS. */
export function rampSteps(saves: number): number {
  if (!Number.isFinite(saves) || saves <= 0) return 0
  return Math.min(RAMP_MAX_STEPS, Math.floor(saves / RAMP_EVERY))
}

/** Speed multiplier for a level after `saves` saves this round. */
export function rampedSpeed(level: Difficulty, saves: number): number {
  return DIFFICULTY_PARAMS[level].speed * (1 + RAMP_SPEED_STEP * rampSteps(saves))
}

export function isDifficulty(v: unknown): v is Difficulty {
  return v === 'easy' || v === 'normal' || v === 'hard'
}

const STORE_KEY = 'gk.difficulty'

/** Last chosen level on this browser, default 'normal'. */
export function loadDifficulty(): Difficulty {
  try {
    const v = localStorage.getItem(STORE_KEY)
    return isDifficulty(v) ? v : 'normal'
  } catch {
    return 'normal'
  }
}

export function saveDifficulty(level: Difficulty): void {
  try {
    localStorage.setItem(STORE_KEY, level)
  } catch {
    /* storage blocked: fine */
  }
}
