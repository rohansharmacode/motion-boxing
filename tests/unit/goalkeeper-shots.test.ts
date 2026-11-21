// Goalkeeper shot generator: seeded, deterministic, every shot type lands in the goal mouth (pure, Node).
import { describe, expect, test } from 'vitest'
import { DIFFICULTY_PARAMS } from '../../src/sports/goalkeeper/difficulty.ts'
import type { DifficultyParams } from '../../src/sports/goalkeeper/difficulty.ts'
import { GOAL_HALF_WIDTH, GOAL_HEIGHT, inGoalMouth, zoneOf } from '../../src/sports/goalkeeper/physics.ts'
import { SHOT_TYPES, pickShotType, planShot, tellAt } from '../../src/sports/goalkeeper/shots.ts'
import type { ShotType } from '../../src/sports/goalkeeper/shots.ts'
import { TELEGRAPH_MS, mulberry32 } from '../../src/sports/goalkeeper/striker.ts'

/** A level that only ever picks one shot type. */
function only(type: ShotType, base: DifficultyParams = DIFFICULTY_PARAMS.normal): DifficultyParams {
  const mix = { straight: 0, curl: 0, dip: 0, skimmer: 0, topCorner: 0 }
  mix[type] = 1
  return { ...base, mix }
}

function many(level: DifficultyParams, n = 200, seed = 1) {
  const rng = mulberry32(seed)
  return Array.from({ length: n }, (_, i) => planShot(i % 5, rng, [], level, level.speed))
}

describe('wind-up', () => {
  test('is 0.6 s', () => {
    expect(TELEGRAPH_MS).toBe(600)
  })
})

describe('pickShotType', () => {
  test('respects a single-type mix', () => {
    const rng = mulberry32(9)
    for (const t of SHOT_TYPES) expect(pickShotType(rng, only(t).mix)).toBe(t)
  })

  test('an all-zero mix falls back to straight', () => {
    expect(pickShotType(mulberry32(1), { straight: 0, curl: 0, dip: 0, skimmer: 0, topCorner: 0 })).toBe('straight')
  })

  test('every type appears on normal over many shots', () => {
    const seen = new Set(many(DIFFICULTY_PARAMS.normal).map((s) => s.shot))
    expect([...seen].sort()).toEqual([...SHOT_TYPES].sort())
  })
})

describe('planShot', () => {
  test('is deterministic for a seed', () => {
    const a = planShot(3, mulberry32(42), [], DIFFICULTY_PARAMS.hard, 1.2)
    const b = planShot(3, mulberry32(42), [], DIFFICULTY_PARAMS.hard, 1.2)
    expect(a).toEqual(b)
  })

  test('different seeds give different shots', () => {
    const a = planShot(0, mulberry32(1), [], DIFFICULTY_PARAMS.normal, 1)
    const b = planShot(0, mulberry32(2), [], DIFFICULTY_PARAMS.normal, 1)
    expect(a).not.toEqual(b)
  })

  test.each([...SHOT_TYPES])('%s always targets inside the goal mouth', (type) => {
    for (const s of many(only(type), 120, 7)) {
      expect(s.shot).toBe(type)
      expect(inGoalMouth(s.target.x, s.target.y)).toBe(true)
      expect(s.target.z).toBe(0)
    }
  })

  test('zone matches the target', () => {
    for (const s of many(DIFFICULTY_PARAMS.hard, 150, 3)) expect(s.zone).toBe(zoneOf(s.target.x, s.target.y))
  })

  test('skimmers stay low', () => {
    for (const s of many(only('skimmer'), 80)) {
      expect(s.target.y).toBeLessThanOrEqual(0.3)
      expect(Math.floor(s.zone / 3)).toBe(2)
    }
  })

  test('top-corner shots are high and wide', () => {
    for (const s of many(only('topCorner', DIFFICULTY_PARAMS.hard), 80)) {
      expect(s.target.y).toBeGreaterThan(GOAL_HEIGHT * 0.7)
      expect(Math.abs(s.target.x)).toBeGreaterThan(GOAL_HALF_WIDTH * 0.6)
      expect(s.tell.high).toBe(true)
    }
  })

  test('dips carry topspin, curls carry strong sidespin, straights little spin', () => {
    for (const s of many(only('dip'), 40)) expect(s.omega.x).toBeGreaterThan(10)
    for (const s of many(only('curl'), 40)) expect(Math.abs(s.omega.y)).toBeGreaterThan(15)
    for (const s of many(only('straight'), 40)) expect(Math.abs(s.omega.y)).toBeLessThan(12)
  })

  test('curls bend toward the side they are aimed at', () => {
    for (const s of many(only('curl'), 80)) {
      if (Math.abs(s.target.x) > 0.3) expect(Math.sign(s.omega.y)).toBe(Math.sign(s.target.x))
    }
  })

  test('faster speed means shorter flight', () => {
    const slow = planShot(1, mulberry32(5), [], only('straight'), 0.8)
    const fast = planShot(1, mulberry32(5), [], only('straight'), 1.3)
    expect(fast.flightTime).toBeLessThan(slow.flightTime)
  })

  test('easy shots fly longer than hard shots on average', () => {
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    const easy = mean(many(DIFFICULTY_PARAMS.easy).map((s) => s.flightTime))
    const hard = mean(many(DIFFICULTY_PARAMS.hard).map((s) => s.flightTime))
    expect(easy).toBeGreaterThan(hard * 1.2)
  })
})

describe('fake-outs', () => {
  test('easy never fakes', () => {
    expect(many(DIFFICULTY_PARAMS.easy, 300).some((s) => s.fake)).toBe(false)
  })

  test('hard fakes sometimes, and only on side shots', () => {
    const shots = many(DIFFICULTY_PARAMS.hard, 400)
    const fakes = shots.filter((s) => s.fake)
    expect(fakes.length).toBeGreaterThan(20)
    for (const s of fakes) {
      expect(s.tell.side).not.toBe(0)
      expect(s.fake?.side).toBe(-s.tell.side)
    }
  })

  test('tellAt shows the feint first, then the real side', () => {
    const plan = { tell: { side: 1 as const, high: false }, fake: { side: -1 as const, high: false }, fakeUntil: 0.45 }
    expect(tellAt(plan, 0.1).side).toBe(-1)
    expect(tellAt(plan, 0.5).side).toBe(1)
    expect(tellAt({ ...plan, fake: null, fakeUntil: 0 }, 0.1).side).toBe(1)
  })
})
