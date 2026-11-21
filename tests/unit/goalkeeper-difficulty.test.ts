// Goalkeeper difficulty levels, auto-ramp and difficulty-scaled kick planning (pure, Node environment).
import { describe, expect, test } from 'vitest'
import {
  DIFFICULTIES,
  DIFFICULTY_PARAMS,
  RAMP_EVERY,
  RAMP_MAX_STEPS,
  RAMP_SPEED_STEP,
  isDifficulty,
  rampSteps,
  rampedSpeed,
} from '../../src/sports/goalkeeper/difficulty.ts'
import { mulberry32, planKick, spreadTarget } from '../../src/sports/goalkeeper/striker.ts'
import type { Zone } from '../../src/sports/goalkeeper/types.ts'

describe('difficulty levels', () => {
  test('three levels, in order', () => {
    expect(DIFFICULTIES).toEqual(['easy', 'normal', 'hard'])
  })

  test.each(['speed', 'curve', 'fake', 'spread'] as const)('%s rises from easy to hard', (key) => {
    const e = DIFFICULTY_PARAMS.easy[key]
    const n = DIFFICULTY_PARAMS.normal[key]
    const h = DIFFICULTY_PARAMS.hard[key]
    expect(e).toBeLessThan(n)
    expect(n).toBeLessThan(h)
  })

  test('normal keeps the original tuning', () => {
    expect(DIFFICULTY_PARAMS.normal.speed).toBe(1)
    expect(DIFFICULTY_PARAMS.normal.curve).toBe(1)
  })

  test('easy never fakes', () => {
    expect(DIFFICULTY_PARAMS.easy.fake).toBe(0)
  })

  test('hard favours tricky shots more than easy does', () => {
    const share = (l: 'easy' | 'hard') => {
      const m = DIFFICULTY_PARAMS[l].mix
      const total = m.straight + m.curl + m.dip + m.skimmer + m.topCorner
      return m.straight / total
    }
    expect(share('hard')).toBeLessThan(share('easy'))
  })

  test('isDifficulty guards strings', () => {
    expect(isDifficulty('hard')).toBe(true)
    expect(isDifficulty('HARD')).toBe(false)
    expect(isDifficulty(null)).toBe(false)
  })
})

describe('auto-ramp', () => {
  test('no ramp before the first three saves', () => {
    expect(rampSteps(0)).toBe(0)
    expect(rampSteps(RAMP_EVERY - 1)).toBe(0)
  })

  test('one step every three saves', () => {
    expect(rampSteps(RAMP_EVERY)).toBe(1)
    expect(rampSteps(RAMP_EVERY * 2)).toBe(2)
    expect(rampSteps(RAMP_EVERY * 2 + 2)).toBe(2)
  })

  test('capped', () => {
    expect(rampSteps(1000)).toBe(RAMP_MAX_STEPS)
  })

  test('bad input means no ramp', () => {
    expect(rampSteps(-3)).toBe(0)
    expect(rampSteps(Number.NaN)).toBe(0)
  })

  test('ramped speed multiplies the level speed', () => {
    expect(rampedSpeed('normal', 0)).toBe(1)
    expect(rampedSpeed('normal', 3)).toBeCloseTo(1 + RAMP_SPEED_STEP)
    expect(rampedSpeed('easy', 6)).toBeCloseTo(DIFFICULTY_PARAMS.easy.speed * (1 + 2 * RAMP_SPEED_STEP))
  })

  test('ramp is monotonic in saves', () => {
    let prev = 0
    for (let s = 0; s < 20; s++) {
      const v = rampedSpeed('hard', s)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })
})

describe('difficulty-scaled planKick', () => {
  const plan = (seed: number, scale = {}) => planKick(2, mulberry32(seed), [] as Zone[], scale)

  test('default scale matches the original plan exactly', () => {
    expect(plan(7, {})).toEqual(planKick(2, mulberry32(7), []))
  })

  test('faster level shortens flight time proportionally', () => {
    const base = plan(11)
    const fast = plan(11, { speed: 1.25 })
    expect(fast.flightTime).toBeCloseTo(base.flightTime / 1.25)
  })

  test('curve scales spin', () => {
    const base = plan(5)
    const curvy = plan(5, { curve: 2 })
    expect(curvy.omega.y).toBeCloseTo(base.omega.y * 2)
    expect(curvy.omega.x).toBeCloseTo(base.omega.x * 2)
  })

  test('low spread pulls the target toward the middle', () => {
    const wide = plan(3, { spread: 1 })
    const tight = plan(3, { spread: 0 })
    expect(Math.abs(tight.target.x)).toBeLessThanOrEqual(Math.abs(wide.target.x))
    expect(Math.abs(tight.target.y - 1.2)).toBeLessThanOrEqual(Math.abs(wide.target.y - 1.2))
  })

  test('spreadTarget at 1 is a no-op, at 0 keeps 40% of the offset', () => {
    const a = { x: 3, y: 2.2, z: 0 }
    spreadTarget(a, 1)
    expect(a).toEqual({ x: 3, y: 2.2, z: 0 })
    const b = { x: 3, y: 2.2, z: 0 }
    spreadTarget(b, 0)
    expect(b.x).toBeCloseTo(1.2)
    expect(b.y).toBeCloseTo(1.2 + 0.4)
  })
})
