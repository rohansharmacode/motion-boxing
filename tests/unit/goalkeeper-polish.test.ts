// @vitest-environment happy-dom
// Goalkeeper polish: round modes (sudden death, daily challenge), kickoff countdown, hit-stop,
// best reaction and the daily high score.
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { HITSTOP_MS, createKeeperEngine } from '../../src/sports/goalkeeper/engine.ts'
import { inGoalMouth } from '../../src/sports/goalkeeper/physics.ts'
import {
  COUNTDOWN_LABELS,
  COUNTDOWN_MS,
  COUNTDOWN_STEP_MS,
  DAILY_KICKS,
  SUDDEN_MAX_KICKS,
  bestReaction,
  countdownLabel,
  dailyKey,
  dailySeed,
  loadDailyBest,
  planDailyRound,
  plannedKicks,
  roundOver,
  saveDailyBest,
} from '../../src/sports/goalkeeper/modes.ts'
import type { RoundMode } from '../../src/sports/goalkeeper/modes.ts'
import { TELEGRAPH_MS, mulberry32 } from '../../src/sports/goalkeeper/striker.ts'
import type { KeeperEngine, KickResult, ShootoutResult, StrikerPhase } from '../../src/sports/goalkeeper/types.ts'
import { createFakeScene, recordMotionEvents } from './helpers/keeper-fakes.ts'

const DT = 1000 / 60
const FAR = { x: 12, y: 6 }
const READY = { x: 0, y: -0.5 }

let rec: ReturnType<typeof recordMotionEvents>
beforeEach(() => {
  localStorage.clear()
  rec = recordMotionEvents()
})
afterEach(() => rec.stop())

// ---------- pure: modes ----------

describe('plannedKicks / roundOver', () => {
  test('planned kicks per mode', () => {
    expect(plannedKicks('classic')).toBe(5)
    expect(plannedKicks('daily')).toBe(DAILY_KICKS)
    expect(plannedKicks('practice')).toBe(3)
    expect(plannedKicks('sudden')).toBeNull()
  })

  const kicks = (...o: ('save' | 'goal')[]) => o.map((outcome) => ({ outcome }))

  test('classic ends after 5 kicks whatever the outcome', () => {
    expect(roundOver('classic', kicks('goal', 'goal', 'goal', 'goal'))).toBe(false)
    expect(roundOver('classic', kicks('save', 'save', 'save', 'save', 'save'))).toBe(true)
  })

  test('sudden death ends on the first goal and only then', () => {
    expect(roundOver('sudden', [])).toBe(false)
    expect(roundOver('sudden', kicks('save', 'save', 'save', 'save', 'save', 'save'))).toBe(false)
    expect(roundOver('sudden', kicks('save', 'save', 'goal'))).toBe(true)
  })

  test('sudden death is capped', () => {
    expect(roundOver('sudden', Array.from({ length: SUDDEN_MAX_KICKS }, () => ({ outcome: 'save' as const })))).toBe(true)
  })
})

describe('daily challenge', () => {
  test('daily key is the local date, zero-padded', () => {
    expect(dailyKey(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(dailyKey(new Date(2026, 10, 21))).toBe('2026-11-21')
  })

  test('seed is stable per day and differs between days', () => {
    expect(dailySeed('2026-11-21')).toBe(dailySeed('2026-11-21'))
    expect(dailySeed('2026-11-21')).not.toBe(dailySeed('2026-11-22'))
  })

  test('the same day always gives the same 10 shots', () => {
    const a = planDailyRound(dailySeed('2026-11-21'))
    const b = planDailyRound(dailySeed('2026-11-21'))
    expect(a).toHaveLength(DAILY_KICKS)
    expect(a).toEqual(b)
  })

  test('a different day gives different shots', () => {
    const a = planDailyRound(dailySeed('2026-11-21')).map((s) => [s.shot, s.zone])
    const b = planDailyRound(dailySeed('2026-11-22')).map((s) => [s.shot, s.zone])
    expect(a).not.toEqual(b)
  })

  test('every daily shot is on target and no zone repeats back to back', () => {
    for (let d = 1; d <= 20; d++) {
      const plans = planDailyRound(dailySeed(`2026-12-${String(d).padStart(2, '0')}`))
      for (const s of plans) expect(inGoalMouth(s.target.x, s.target.y)).toBe(true)
      for (let i = 1; i < plans.length; i++) {
        // planKick avoids the previous zone; shot types may then nudge the aim (e.g. skimmer low), so allow
        // a repeat only when the shot reshaped the target.
        if (plans[i].zone === plans[i - 1].zone) expect(plans[i].shot).not.toBe('straight')
      }
    }
  })

  test('later daily shots are faster on average', () => {
    let early = 0
    let late = 0
    for (let d = 1; d <= 28; d++) {
      const p = planDailyRound(dailySeed(`2027-02-${String(d).padStart(2, '0')}`))
      early += p[0].flightTime + p[1].flightTime + p[2].flightTime
      late += p[7].flightTime + p[8].flightTime + p[9].flightTime
    }
    expect(late).toBeLessThan(early)
  })
})

describe('daily high score', () => {
  test('starts empty, keeps the best, ignores worse scores', () => {
    expect(loadDailyBest('2026-11-21')).toBeNull()
    expect(saveDailyBest('2026-11-21', 3000)).toBe(true)
    expect(saveDailyBest('2026-11-21', 2500)).toBe(false)
    expect(loadDailyBest('2026-11-21')).toBe(3000)
    expect(saveDailyBest('2026-11-21', 3200)).toBe(true)
    expect(loadDailyBest('2026-11-21')).toBe(3200)
  })

  test('each day has its own best', () => {
    saveDailyBest('2026-11-21', 5000)
    expect(loadDailyBest('2026-11-22')).toBeNull()
  })

  test('bad scores are ignored', () => {
    expect(saveDailyBest('2026-11-21', Number.NaN)).toBe(false)
    expect(saveDailyBest('2026-11-21', -5)).toBe(false)
    expect(loadDailyBest('2026-11-21')).toBeNull()
  })

  test('blocked storage never throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(loadDailyBest('k', broken)).toBeNull()
    expect(saveDailyBest('k', 10, broken)).toBe(false)
    expect(saveDailyBest('k', 10, null)).toBe(false)
  })
})

describe('kickoff countdown', () => {
  test('3, 2, 1, GO! then nothing', () => {
    expect(COUNTDOWN_LABELS).toEqual(['3', '2', '1', 'GO!'])
    expect(countdownLabel(0)).toBe('3')
    expect(countdownLabel(COUNTDOWN_STEP_MS)).toBe('2')
    expect(countdownLabel(COUNTDOWN_STEP_MS * 2 + 1)).toBe('1')
    expect(countdownLabel(COUNTDOWN_STEP_MS * 3)).toBe('GO!')
    expect(countdownLabel(COUNTDOWN_MS)).toBeNull()
    expect(countdownLabel(-5)).toBe('3')
  })
})

describe('bestReaction', () => {
  const k = (outcome: 'save' | 'goal', part: KickResult['part'], reactionMs: number | null) => ({ outcome, part, reactionMs })

  test('fastest reaction among real saves', () => {
    expect(bestReaction([k('save', 'left', 520), k('save', 'right', 410), k('save', 'torso', 600)])).toBe(410)
  })

  test('goals, wide shots and unmeasured reactions do not count', () => {
    expect(bestReaction([k('goal', null, 200), k('save', null, 150), k('save', 'left', null), k('save', 'left', 700)])).toBe(700)
    expect(bestReaction([k('goal', null, 200)])).toBeNull()
    expect(bestReaction([])).toBeNull()
  })
})

// ---------- engine ----------

interface H {
  engine: KeeperEngine
  kicks: KickResult[]
  ends: ShootoutResult[]
  phases: { phase: StrikerPhase; kick: number; frame: number }[]
  frame: number
}

function setup(seed: number): H {
  const engine = createKeeperEngine({ rng: mulberry32(seed) })
  engine.init(createFakeScene(), null)
  const h: H = { engine, kicks: [], ends: [], phases: [], frame: 0 }
  engine.onKickResult((r) => h.kicks.push(r))
  engine.onShootoutEnd((r) => h.ends.push(r))
  engine.onStrikerPhase((phase, kick) => h.phases.push({ phase, kick, frame: h.frame }))
  return h
}

function run(h: H, before: (h: H) => void, maxFrames = 60 * 240): void {
  for (let i = 0; i < maxFrames; i++) {
    before(h)
    h.engine.update(DT)
    h.frame++
    if (h.engine.phase === 'ended') return
  }
  throw new Error('round did not finish')
}

function keeper(delayMs: number): (h: H) => void {
  return (h) => {
    const p = h.phases[h.phases.length - 1]
    if (p && (p.phase === 'telegraph' || p.phase === 'kick' || p.phase === 'recover')) {
      const tf = h.phases.filter((q) => q.phase === 'telegraph' && q.kick === p.kick).pop()?.frame
      if (tf !== undefined && (h.frame - tf) * DT >= delayMs) {
        h.engine.setPointer({ x: Number(h.engine.debug.targetX), y: Number(h.engine.debug.targetY) })
        return
      }
    }
    h.engine.setPointer(READY)
  }
}

const start = (h: H, mode: RoundMode, extra: { countdownMs?: number; date?: Date } = {}) =>
  h.engine.startShootout({ mode, ...extra })

describe('engine: sudden death', () => {
  test('one goal ends it straight away', () => {
    const h = setup(4)
    start(h, 'sudden')
    run(h, (hh) => hh.engine.setPointer(FAR))
    expect(h.kicks).toHaveLength(1)
    expect(h.ends[0].mode).toBe('sudden')
    expect(h.ends[0].saves).toBe(0)
  })

  test('a good keeper keeps going past 5 kicks until a goal or the cap', () => {
    const h = setup(21)
    h.engine.setDifficulty('easy')
    start(h, 'sudden')
    run(h, keeper(250))
    const last = h.kicks[h.kicks.length - 1]
    expect(h.kicks.length === SUDDEN_MAX_KICKS || last.outcome === 'goal').toBe(true)
    expect(h.kicks.slice(0, -1).every((k) => k.outcome === 'save')).toBe(true)
    expect(h.kicks.length).toBeGreaterThan(5)
  })

  test('SAVE/GOAL telemetry carries the mode', () => {
    const h = setup(4)
    start(h, 'sudden')
    run(h, (hh) => hh.engine.setPointer(FAR))
    const kickEvents = rec.events.filter((e) => e.event_type === 'GOAL' || e.event_type === 'SAVE')
    expect(kickEvents.every((e) => e.metrics.mode === 'sudden')).toBe(true)
  })
})

describe('engine: daily challenge', () => {
  const date = new Date(2026, 10, 21)
  const shots = (h: H) => h.kicks.map((k) => [k.shot, k.zone])

  test('10 kicks, tagged with the day', () => {
    const h = setup(1)
    start(h, 'daily', { date })
    run(h, (hh) => hh.engine.setPointer(FAR))
    expect(h.kicks).toHaveLength(DAILY_KICKS)
    expect(h.ends[0].mode).toBe('daily')
    expect(h.ends[0].dailyKey).toBe('2026-11-21')
  })

  test('same day, same shots: independent of the RNG seed and of how the keeper plays', () => {
    const a = setup(1)
    start(a, 'daily', { date })
    run(a, (hh) => hh.engine.setPointer(FAR))
    const b = setup(999)
    b.engine.setDifficulty('easy')
    start(b, 'daily', { date })
    run(b, keeper(250))
    expect(shots(b)).toEqual(shots(a))
    expect(b.kicks.some((k) => k.outcome === 'save')).toBe(true)
  })

  test('the next day is a different challenge', () => {
    const a = setup(1)
    start(a, 'daily', { date })
    run(a, (hh) => hh.engine.setPointer(FAR))
    const b = setup(1)
    start(b, 'daily', { date: new Date(2026, 10, 22) })
    run(b, (hh) => hh.engine.setPointer(FAR))
    expect(shots(b)).not.toEqual(shots(a))
  })
})

describe('engine: countdown, hit-stop and best reaction', () => {
  test('countdownMs holds the first kick until the countdown is over', () => {
    const plain = setup(3)
    start(plain, 'classic')
    const counted = setup(3)
    start(counted, 'classic', { countdownMs: COUNTDOWN_MS })
    const firstTelegraph = (h: H) => {
      run(h, (hh) => hh.engine.setPointer(FAR))
      return h.phases.find((p) => p.phase === 'telegraph')?.frame ?? -1
    }
    const a = firstTelegraph(plain)
    const b = firstTelegraph(counted)
    // Default first wait is IDLE_MS (1400): the countdown (2400) adds about 1000 ms.
    expect((b - a) * DT).toBeGreaterThan(COUNTDOWN_MS - 1400 - 2 * DT)
    expect((b - a) * DT).toBeLessThan(COUNTDOWN_MS - 1400 + 2 * DT)
  })

  test('a goal never triggers the hit-stop', () => {
    const h = setup(11)
    start(h, 'classic')
    const scales: number[] = []
    run(h, (hh) => {
      hh.engine.setPointer(FAR)
      if (hh.kicks.length > 0) scales.push(hh.engine.timeScale)
    })
    expect(scales.includes(0)).toBe(false)
  })

  test('a save freezes the world for about HITSTOP_MS', () => {
    const h = setup(21)
    h.engine.setDifficulty('easy')
    start(h, 'classic')
    let saveFrame = -1
    let frozen = 0
    run(h, (hh) => {
      keeper(250)(hh)
      if (saveFrame < 0 && hh.kicks.some((k) => k.part !== null)) saveFrame = hh.frame
      if (saveFrame >= 0 && hh.frame - saveFrame < 30 && hh.engine.timeScale === 0) frozen++
    })
    expect(frozen * DT).toBeGreaterThanOrEqual(HITSTOP_MS - DT)
    expect(frozen * DT).toBeLessThanOrEqual(HITSTOP_MS + DT)
  })

  test('results report the fastest reaction of the round', () => {
    const h = setup(21)
    h.engine.setDifficulty('easy')
    start(h, 'classic')
    run(h, keeper(250))
    const saves = h.kicks.filter((k) => k.outcome === 'save' && k.part !== null && k.reactionMs !== null)
    expect(saves.length).toBeGreaterThan(0)
    expect(h.ends[0].bestReactionMs).toBe(Math.min(...saves.map((k) => k.reactionMs ?? Infinity)))
    // Reaction is measured from the start of the wind-up: never before the minimum human time.
    expect(h.ends[0].bestReactionMs ?? 0).toBeGreaterThanOrEqual(100)
    expect(h.ends[0].bestReactionMs ?? 0).toBeLessThan(TELEGRAPH_MS + 1000)
  })
})

describe('sudden-death grade', () => {
  test('graded on the streak: S 10+, A 6+, B 3+, else C', async () => {
    const { suddenGrade } = await import('../../src/sports/goalkeeper/modes.ts')
    expect([0, 2, 3, 5, 6, 9, 10, 25].map(suddenGrade)).toEqual(['C', 'C', 'B', 'B', 'A', 'A', 'S', 'S'])
  })

  test('the engine uses it for sudden-death results', () => {
    const h = setup(21)
    h.engine.setDifficulty('easy')
    start(h, 'sudden')
    run(h, keeper(250))
    const streak = h.ends[0].saves
    const want = streak >= 10 ? 'S' : streak >= 6 ? 'A' : streak >= 3 ? 'B' : 'C'
    expect(h.ends[0].grade).toBe(want)
  })
})
