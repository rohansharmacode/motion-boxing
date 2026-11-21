// @vitest-environment happy-dom
// Goalkeeper engine with difficulty, grades, combos and the guided practice. Time is driven only by
// engine.update(dt); the striker is seeded with mulberry32.
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createKeeperEngine } from '../../src/sports/goalkeeper/engine.ts'
import { PRACTICE_KICKS, PRACTICE_SPEED, planPracticeShot } from '../../src/sports/goalkeeper/shots.ts'
import { mulberry32 } from '../../src/sports/goalkeeper/striker.ts'
import type { KeeperEngine, KickResult, ShootoutResult, StrikerPhase } from '../../src/sports/goalkeeper/types.ts'
import { KICKS_PER_SHOOTOUT } from '../../src/sports/goalkeeper/types.ts'
import { createFakeScene, recordMotionEvents } from './helpers/keeper-fakes.ts'

const DT = 1000 / 60
const MAX_FRAMES = 60 * 60
const FAR = { x: 12, y: 6 }
const READY = { x: 0, y: -0.5 }

let rec: ReturnType<typeof recordMotionEvents>
beforeEach(() => {
  localStorage.clear()
  rec = recordMotionEvents()
})
afterEach(() => rec.stop())

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

function run(h: H, before: (h: H) => void): void {
  for (let i = 0; i < MAX_FRAMES; i++) {
    before(h)
    h.engine.update(DT)
    h.frame++
    if (h.engine.phase === 'ended') return
  }
  throw new Error('round did not finish')
}

/** Waits at READY, then moves the gloves onto the target `delayMs` after the wind-up starts. */
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

const saveEvents = () => rec.events.filter((e) => e.event_type === 'SAVE' || e.event_type === 'GOAL')
const summaries = () => rec.events.filter((e) => e.event_type === 'TICK' && e.metrics.summary === true)

describe('guided practice', () => {
  test('runs exactly 3 kicks and ends flagged as practice', () => {
    const h = setup(1)
    h.engine.startShootout({ practice: true })
    expect(h.engine.practice).toBe(true)
    run(h, keeper(200))
    expect(h.kicks).toHaveLength(PRACTICE_KICKS)
    expect(h.ends).toHaveLength(1)
    expect(h.ends[0].practice).toBe(true)
  })

  test('sends no SAVE/GOAL events and no summary to the server', () => {
    const h = setup(2)
    h.engine.startShootout({ practice: true })
    run(h, (hh) => hh.engine.setPointer(FAR))
    expect(saveEvents()).toHaveLength(0)
    expect(summaries()).toHaveLength(0)
  })

  test('uses the fixed slow shots: left, right, high centre', () => {
    const zones = [0, 1, 2].map((i) => planPracticeShot(i))
    expect(zones[0].tell.side).toBe(-1)
    expect(zones[1].tell.side).toBe(1)
    expect(zones[2].tell.high).toBe(true)
    for (const s of zones) {
      expect(s.fake).toBeNull()
      expect(s.flightTime).toBeCloseTo(0.95 / PRACTICE_SPEED)
    }
  })

  test('a scored shootout after practice is back to 5 kicks and normal telemetry', () => {
    const h = setup(3)
    h.engine.startShootout({ practice: true })
    run(h, (hh) => hh.engine.setPointer(FAR))
    h.engine.startShootout()
    expect(h.engine.practice).toBe(false)
    run(h, (hh) => hh.engine.setPointer(FAR))
    expect(h.kicks).toHaveLength(PRACTICE_KICKS + KICKS_PER_SHOOTOUT)
    expect(saveEvents()).toHaveLength(KICKS_PER_SHOOTOUT)
    expect(summaries()).toHaveLength(1)
  })
})

describe('grades, combo and results in the engine', () => {
  test('every goal is graded miss with zero points and grade C', () => {
    const h = setup(11)
    h.engine.startShootout()
    run(h, (hh) => hh.engine.setPointer(FAR))
    expect(h.kicks.every((k) => k.grade === 'miss' && k.points === 0 && k.combo === 0)).toBe(true)
    expect(h.ends[0].grade).toBe('C')
    expect(h.ends[0].bestCombo).toBe(0)
    expect(h.ends[0].savePct).toBe(0)
  })

  test('an early, centred keeper builds a combo and the score sums the kick points', () => {
    const h = setup(21)
    h.engine.setDifficulty('easy')
    h.engine.startShootout()
    run(h, keeper(250))
    const saved = h.kicks.filter((k) => k.outcome === 'save' && k.part !== null)
    expect(saved.length).toBeGreaterThanOrEqual(3)
    expect(h.ends[0].bestCombo).toBeGreaterThanOrEqual(3)
    const sum = h.kicks.reduce((a, k) => a + (k.points ?? 0), 0)
    expect(h.ends[0].score).toBe(sum)
    for (const k of saved) expect(['perfect', 'good', 'fingertip']).toContain(k.grade)
  })

  test('difficulty is stamped on every kick and the result', () => {
    const h = setup(5)
    h.engine.setDifficulty('hard')
    h.engine.startShootout()
    run(h, (hh) => hh.engine.setPointer(FAR))
    expect(h.kicks.every((k) => k.difficulty === 'hard')).toBe(true)
    expect(h.ends[0].difficulty).toBe('hard')
  })

  test('auto-ramp steps up after three saves', () => {
    const h = setup(21)
    h.engine.setDifficulty('easy')
    h.engine.startShootout()
    run(h, keeper(250))
    let saves = 0
    for (const k of h.kicks) {
      expect(k.rampStep).toBe(saves >= 3 ? 1 : 0)
      if (k.outcome === 'save' && k.part !== null) saves++
    }
  })

  test('SAVE/GOAL telemetry carries difficulty, save grade and shot as optional metrics', () => {
    const h = setup(21)
    h.engine.setDifficulty('normal')
    h.engine.startShootout()
    run(h, keeper(250))
    const events = saveEvents()
    expect(events).toHaveLength(KICKS_PER_SHOOTOUT)
    for (const e of events) {
      expect(e.metrics.difficulty).toBe('normal')
      expect(['perfect', 'good', 'fingertip', 'miss', null]).toContain(e.metrics.saveGrade)
      expect(typeof e.metrics.shot).toBe('string')
      // existing fields are untouched
      expect(e.metrics).toHaveProperty('zone')
      expect(e.metrics).toHaveProperty('part')
    }
    const summary = summaries()[0]
    expect(summary.metrics.difficulty).toBe('normal')
    expect(['S', 'A', 'B', 'C']).toContain(summary.metrics.grade)
  })
})

describe('seeded replays', () => {
  const replay = (seed: number, level: 'easy' | 'normal' | 'hard') => {
    const h = setup(seed)
    h.engine.setDifficulty(level)
    h.engine.startShootout()
    run(h, keeper(300))
    return h.kicks.map((k) => [k.shot, k.zone, k.grade, k.fake, k.outcome])
  }

  test.each(['easy', 'normal', 'hard'] as const)('same seed, same %s shootout', (level) => {
    expect(replay(77, level)).toEqual(replay(77, level))
  })

  test('different seeds give a different shootout', () => {
    expect(replay(77, 'hard')).not.toEqual(replay(78, 'hard'))
  })
})
