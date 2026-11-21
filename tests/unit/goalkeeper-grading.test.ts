// Goalkeeper save grading, combo multiplier, round scoring and S/A/B/C results grade (pure, Node).
import { describe, expect, test } from 'vitest'
import {
  COMBO_MAX,
  GRADE_POINTS,
  PUNCH_BONUS,
  TIMING_BEST_MS,
  TIMING_UNKNOWN,
  TIMING_WORST_MS,
  comboMultiplier,
  gradeSave,
  kickPoints,
  maxScore,
  nextCombo,
  resultGrade,
  saveQuality,
  scoreKicks,
  timingScore,
} from '../../src/sports/goalkeeper/grading.ts'
import type { GradeInput } from '../../src/sports/goalkeeper/grading.ts'

const save = (accuracy: number, reactionMs: number | null, part: GradeInput['part'] = 'left'): GradeInput => ({
  outcome: 'save',
  part,
  accuracy,
  reactionMs,
})

describe('timing', () => {
  test('fast reaction is full marks, very late is zero', () => {
    expect(timingScore(TIMING_BEST_MS)).toBe(1)
    expect(timingScore(200)).toBe(1)
    expect(timingScore(TIMING_WORST_MS)).toBe(0)
    expect(timingScore(5000)).toBe(0)
  })

  test('linear in between', () => {
    const mid = (TIMING_BEST_MS + TIMING_WORST_MS) / 2
    expect(timingScore(mid)).toBeCloseTo(0.5)
  })

  test('unmeasured reaction gets partial credit', () => {
    expect(timingScore(null)).toBe(TIMING_UNKNOWN)
    expect(timingScore(Number.NaN)).toBe(TIMING_UNKNOWN)
  })
})

describe('saveQuality', () => {
  test('centred and fast is 1, off-centre and late is 0', () => {
    expect(saveQuality({ accuracy: 100, reactionMs: 300 })).toBeCloseTo(1)
    expect(saveQuality({ accuracy: 0, reactionMs: 2000 })).toBeCloseTo(0)
  })

  test('accuracy outside 0..100 is clamped', () => {
    expect(saveQuality({ accuracy: 250, reactionMs: 300 })).toBeCloseTo(1)
    expect(saveQuality({ accuracy: -40, reactionMs: 2000 })).toBeCloseTo(0)
  })

  test('accuracy matters more than timing', () => {
    expect(saveQuality({ accuracy: 100, reactionMs: 2000 })).toBeGreaterThan(saveQuality({ accuracy: 0, reactionMs: 300 }))
  })
})

describe('gradeSave', () => {
  test('a goal is a miss', () => {
    expect(gradeSave({ outcome: 'goal', part: null, accuracy: 90, reactionMs: 300 })).toBe('miss')
  })

  test('a wide shot has no grade', () => {
    expect(gradeSave(save(0, null, null))).toBeNull()
  })

  test('perfect / good / fingertip by quality', () => {
    expect(gradeSave(save(95, 350))).toBe('perfect')
    expect(gradeSave(save(60, 700))).toBe('good')
    expect(gradeSave(save(10, 1000))).toBe('fingertip')
  })

  test('a late but centred save drops below perfect', () => {
    expect(gradeSave(save(85, 350))).toBe('perfect')
    expect(gradeSave(save(85, 1100))).toBe('good')
  })

  test('a body block is never perfect', () => {
    expect(gradeSave(save(100, 300, 'torso'))).toBe('good')
  })

  test('either glove can be perfect', () => {
    expect(gradeSave(save(100, 300, 'right'))).toBe('perfect')
  })
})

describe('combo', () => {
  test('saves build, goals reset, wide shots leave it', () => {
    expect(nextCombo(0, 'good')).toBe(1)
    expect(nextCombo(2, 'fingertip')).toBe(3)
    expect(nextCombo(4, 'miss')).toBe(0)
    expect(nextCombo(3, null)).toBe(3)
  })

  test('multiplier is x1 for 0 or 1, +0.25 per extra save, capped', () => {
    expect(comboMultiplier(0)).toBe(1)
    expect(comboMultiplier(1)).toBe(1)
    expect(comboMultiplier(2)).toBe(1.25)
    expect(comboMultiplier(3)).toBe(1.5)
    expect(comboMultiplier(50)).toBe(COMBO_MAX)
  })
})

describe('kickPoints', () => {
  test('base points per grade', () => {
    expect(kickPoints('perfect', 1)).toBe(GRADE_POINTS.perfect)
    expect(kickPoints('good', 1)).toBe(GRADE_POINTS.good)
    expect(kickPoints('fingertip', 1)).toBe(GRADE_POINTS.fingertip)
  })

  test('misses and wide shots score nothing', () => {
    expect(kickPoints('miss', 5)).toBe(0)
    expect(kickPoints(null, 5)).toBe(0)
  })

  test('combo multiplies, punch adds a flat bonus', () => {
    expect(kickPoints('good', 3)).toBe(1500)
    expect(kickPoints('good', 1, true)).toBe(GRADE_POINTS.good + PUNCH_BONUS)
  })
})

describe('scoreKicks', () => {
  test('replays a round in order', () => {
    const s = scoreKicks([{ grade: 'perfect' }, { grade: 'good' }, { grade: 'miss' }, { grade: 'fingertip' }, { grade: null }])
    expect(s.score).toBe(1500 + 1000 * 1.25 + 0 + 600)
    expect(s.bestCombo).toBe(2)
    expect([s.perfects, s.goods, s.fingertips, s.misses]).toEqual([1, 1, 1, 1])
  })

  test('a clean sheet of perfects hits the max score', () => {
    const kicks = Array.from({ length: 5 }, () => ({ grade: 'perfect' as const }))
    expect(scoreKicks(kicks).score).toBe(maxScore(5))
    expect(scoreKicks(kicks).bestCombo).toBe(5)
  })

  test('empty round', () => {
    expect(scoreKicks([])).toEqual({ score: 0, bestCombo: 0, perfects: 0, goods: 0, fingertips: 0, misses: 0 })
  })
})

describe('resultGrade', () => {
  test('S needs every save and a high score', () => {
    expect(resultGrade(5, 5, maxScore(5))).toBe('S')
    expect(resultGrade(5, 5, 0.5 * maxScore(5))).toBe('A')
  })

  test('A / B / C by save percentage', () => {
    expect(resultGrade(4, 5, 4000)).toBe('A')
    expect(resultGrade(3, 5, 3000)).toBe('B')
    expect(resultGrade(2, 5, 2000)).toBe('C')
    expect(resultGrade(0, 5, 0)).toBe('C')
  })

  test('no kicks is a C', () => {
    expect(resultGrade(0, 0, 0)).toBe('C')
  })
})
