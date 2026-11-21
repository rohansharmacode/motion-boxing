// @vitest-environment happy-dom
// Goalkeeper engine: save detection, shootout flow, slow-mo, reaction guard and telemetry.
// Time is driven only by engine.update(dt); the striker is seeded with mulberry32.
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { KeeperEngine, KickResult, ShootoutResult, StrikerPhase } from '../../src/sports/goalkeeper/types.ts'
import { HITSTOP_MS, createKeeperEngine } from '../../src/sports/goalkeeper/engine.ts'
import { TELEGRAPH_MS, mulberry32 } from '../../src/sports/goalkeeper/striker.ts'
import { KICKS_PER_SHOOTOUT } from '../../src/sports/goalkeeper/types.ts'
import {
  TEST_CALIBRATION,
  bodyFrame,
  createFakeScene,
  goalToBody,
  recordMotionEvents,
  type FakeScene,
} from './helpers/keeper-fakes.ts'

const DT = 1000 / 60
/** Enough frames for a whole 5-kick shootout (about 30 s of game time plus slow-mo). */
const MAX_FRAMES = 60 * 60

/** Off the pitch: gloves and torso are metres from any target. */
const FAR = { x: 12, y: 6 }
/** Ready spot below the goal: any move to a target is fast and in the target's direction. */
const READY = { x: 0, y: -0.5 }

let rec: ReturnType<typeof recordMotionEvents>
beforeEach(() => {
  localStorage.clear()
  rec = recordMotionEvents()
})
afterEach(() => rec.stop())

interface Harness {
  engine: KeeperEngine
  scene: FakeScene
  kicks: KickResult[]
  ends: ShootoutResult[]
  phases: { phase: StrikerPhase; kick: number; frame: number }[]
  frame: number
}

function setup(seed: number, calibrated = false): Harness {
  const engine = createKeeperEngine({ rng: mulberry32(seed) })
  const scene = createFakeScene()
  engine.init(scene, calibrated ? TEST_CALIBRATION : null)
  const h: Harness = { engine, scene, kicks: [], ends: [], phases: [], frame: 0 }
  engine.onKickResult((r) => h.kicks.push(r))
  engine.onShootoutEnd((r) => h.ends.push(r))
  engine.onStrikerPhase((phase, kick) => h.phases.push({ phase, kick, frame: h.frame }))
  return h
}

/** Run frames until done() or the shootout ends. before(frame) runs ahead of each update. */
function run(h: Harness, before: (h: Harness) => void, done: (h: Harness) => boolean = () => false): void {
  for (let i = 0; i < MAX_FRAMES; i++) {
    before(h)
    h.engine.update(DT)
    h.frame++
    if (h.engine.phase === 'ended' || done(h)) return
  }
  throw new Error('shootout did not finish')
}

function lastPhase(h: Harness): { phase: StrikerPhase; kick: number; frame: number } | undefined {
  return h.phases[h.phases.length - 1]
}

/** A keeper that waits at READY and jumps the pointer to the target `delayMs` after the telegraph. */
function perfectKeeper(delayMs: number): (h: Harness) => void {
  return (h) => {
    const p = lastPhase(h)
    if (p && (p.phase === 'telegraph' || p.phase === 'kick' || p.phase === 'recover')) {
      const telegraphFrame = h.phases.filter((q) => q.phase === 'telegraph' && q.kick === p.kick).pop()?.frame
      if (telegraphFrame !== undefined && (h.frame - telegraphFrame) * DT >= delayMs) {
        h.engine.setPointer({ x: Number(h.engine.debug.targetX), y: Number(h.engine.debug.targetY) })
        return
      }
    }
    h.engine.setPointer(READY)
  }
}

describe('keeper engine: shootout and save detection', () => {
  test('pointer parked far away: 5 goals, one end callback, 5 GOAL events and one summary TICK', () => {
    const h = setup(11)
    h.engine.startShootout()
    expect(h.engine.phase).toBe('playing')
    run(h, (hh) => hh.engine.setPointer(FAR))

    expect(h.engine.phase).toBe('ended')
    expect(h.kicks).toHaveLength(KICKS_PER_SHOOTOUT)
    expect(h.kicks.map((k) => k.outcome)).toEqual(['goal', 'goal', 'goal', 'goal', 'goal'])
    expect(h.kicks.every((k) => k.part === null)).toBe(true)
    expect(h.kicks.map((k) => k.kick)).toEqual([0, 1, 2, 3, 4])
    expect(h.engine.kickIndex).toBe(5)

    expect(h.ends).toHaveLength(1)
    expect(h.ends[0].goals).toBe(5)
    expect(h.ends[0].saves).toBe(0)
    expect(h.ends[0].score).toBe(0)

    const goals = rec.events.filter((e) => e.event_type === 'GOAL')
    expect(goals).toHaveLength(5)
    expect(rec.events.filter((e) => e.event_type === 'SAVE')).toHaveLength(0)
    for (const g of goals) {
      expect(g.sport).toBe('GOALKEEPER')
      expect(g.metrics.source).toBe('mouse')
      expect(g.metrics.offTarget).toBe(false)
    }
    const summaries = rec.events.filter((e) => e.event_type === 'TICK' && e.metrics.summary === true)
    expect(summaries).toHaveLength(1)
    const counts = summaries[0].metrics.counts as { total: number; saves: number; goals: number; kicks: number }
    expect(counts).toEqual({ total: 0, saves: 0, goals: 5, kicks: 5 })
    expect(summaries[0].metrics.outcome).toBe('loss')
    // The summary is the last event dispatched.
    expect(rec.events[rec.events.length - 1]).toBe(summaries[0])

    expect(h.scene.count('flashGoal')).toBe(5)
    expect(h.scene.count('flashSave')).toBe(0)
    // Every flashGoal point is on the goal plane inside the mouth.
    for (const c of h.scene.calls.filter((c) => c.name === 'flashGoal')) {
      const p = c.args[0] as { x: number; y: number; z: number }
      expect(p.z).toBeCloseTo(0, 6)
      expect(Math.abs(p.x)).toBeLessThan(3.66)
    }
    // The engine never drives the scene clock or rendering.
    expect(h.scene.count('update')).toBe(0)
    expect(h.scene.count('render')).toBe(0)
  })

  test('perfect keeper: every kick saved by a glove or torso with a plausible reaction and speed', () => {
    const h = setup(11)
    h.engine.startShootout()
    run(h, perfectKeeper(150))

    expect(h.kicks).toHaveLength(5)
    for (const k of h.kicks) {
      expect(k.outcome).toBe('save')
      expect(['left', 'right', 'torso']).toContain(k.part)
      expect(k.reactionMs).not.toBeNull()
      expect(k.reactionMs!).toBeGreaterThanOrEqual(100)
      expect(k.reactionMs!).toBeLessThan(400)
      expect(k.peakVelocity).toBeGreaterThan(0)
      // Mouse cap 8 m/s over the default 0.4 m shoulder width.
      expect(k.peakVelocity).toBeLessThanOrEqual(20 + 1e-9)
      expect(k.accuracy).toBeGreaterThanOrEqual(0)
      expect(k.accuracy).toBeLessThanOrEqual(100)
    }
    expect(h.ends).toHaveLength(1)
    expect(h.ends[0].saves).toBe(5)
    expect(h.ends[0].score).toBeGreaterThanOrEqual(5000)

    const saves = rec.events.filter((e) => e.event_type === 'SAVE')
    expect(saves).toHaveLength(5)
    expect(rec.events.filter((e) => e.event_type === 'GOAL')).toHaveLength(0)
    for (const s of saves) {
      expect(s.reaction_ms).not.toBeNull()
      expect(s.reaction_ms!).toBeGreaterThanOrEqual(100)
      expect(s.peak_velocity!).toBeGreaterThan(0)
      expect(s.peak_velocity!).toBeLessThanOrEqual(20 + 1e-9)
      expect(['left', 'right', 'torso']).toContain(s.metrics.part)
    }
    const summary = rec.events.filter((e) => e.event_type === 'TICK' && e.metrics.summary === true)
    expect(summary).toHaveLength(1)
    expect((summary[0].metrics.counts as { total: number }).total).toBe(5)
    expect(h.scene.count('flashSave')).toBe(5)
    expect(h.scene.count('flashGoal')).toBe(0)
  })

  test('a save freezes the world (hit-stop), drops timeScale to about 0.3, then it returns to 1', () => {
    const h = setup(11)
    h.engine.startShootout()
    let saveFrame = -1
    const scales: number[] = []
    run(
      h,
      (hh) => {
        perfectKeeper(150)(hh)
        if (saveFrame < 0 && hh.kicks.length > 0) saveFrame = hh.frame
        if (saveFrame >= 0) scales.push(hh.engine.timeScale)
      },
      (hh) => saveFrame >= 0 && hh.frame - saveFrame > 90,
    )
    expect(h.kicks[0].outcome).toBe('save')
    expect(scales[0]).toBeCloseTo(1, 9) // not yet recomputed at the save frame
    // Hit-stop first: the world is frozen (0) for about HITSTOP_MS, then the 0.3 slow-mo.
    const frozen = scales.filter((s) => s === 0).length
    expect(frozen * DT).toBeGreaterThanOrEqual(HITSTOP_MS - DT)
    expect(frozen * DT).toBeLessThanOrEqual(HITSTOP_MS + DT)
    const firstMoving = scales.findIndex((s, i) => i > 0 && s > 0)
    expect(scales.slice(1, firstMoving).every((s) => s === 0)).toBe(true)
    const minScale = Math.min(...scales.filter((s) => s > 0))
    expect(minScale).toBeCloseTo(0.3, 6)
    // Held at 0.3 for a while (60% of 700 ms), then eases back to exactly 1 within ~1 s.
    expect(scales.filter((s) => Math.abs(s - 0.3) < 1e-9).length).toBeGreaterThanOrEqual(20)
    expect(scales[scales.length - 1]).toBe(1)
    const firstOne = scales.findIndex((s, i) => i > 1 && s === 1)
    // The 700 ms slow-mo starts after the hit-stop.
    expect(firstOne * DT).toBeGreaterThan(600 + HITSTOP_MS)
    expect(firstOne * DT).toBeLessThan(800 + HITSTOP_MS)
  })

  test('a glove already moving fast before the telegraph never yields a reaction under 100 ms', () => {
    const h = setup(23)
    h.engine.startShootout()
    let jiggle = 0
    run(h, (hh) => {
      const p = lastPhase(hh)
      const tf = hh.phases.filter((q) => q.phase === 'telegraph' && q.kick === p?.kick).pop()?.frame
      const sinceTelegraph = p && tf !== undefined && p.phase !== 'runup' && p.phase !== 'idle' ? (hh.frame - tf) * DT : -1
      if (p?.phase === 'runup' || (sinceTelegraph >= 0 && sinceTelegraph < 40)) {
        // Wild 1 m jumps every frame: speed pinned at the 8 m/s cap.
        jiggle++
        hh.engine.setPointer({ x: jiggle % 2 === 0 ? -0.5 : 0.5, y: 1.2 })
      } else if (sinceTelegraph >= 40) {
        hh.engine.setPointer({ x: Number(hh.engine.debug.targetX), y: Number(hh.engine.debug.targetY) })
      } else {
        hh.engine.setPointer(READY)
      }
    })
    expect(h.kicks).toHaveLength(5)
    expect(jiggle).toBeGreaterThan(100)
    for (const k of h.kicks) {
      if (k.reactionMs !== null) expect(k.reactionMs).toBeGreaterThanOrEqual(100)
      // The glove was going flat out, so peak speed is recorded even without a valid reaction.
      expect(k.peakVelocity).toBeGreaterThan(5)
    }
    // The jump to the target happened inside the anticipation window, so most kicks get no reaction.
    expect(h.kicks.filter((k) => k.reactionMs === null).length).toBeGreaterThanOrEqual(3)
  })
})

/** ms since this kick's telegraph began, or -1 before it (idle / runup). */
function sinceTelegraph(h: Harness): number {
  const p = lastPhase(h)
  if (!p || p.phase === 'idle' || p.phase === 'runup') return -1
  const tf = h.phases.filter((q) => q.phase === 'telegraph' && q.kick === p.kick).pop()?.frame
  return tf === undefined ? -1 : (h.frame - tf) * DT
}

function target(h: Harness): { x: number; y: number } {
  return { x: Number(h.engine.debug.targetX), y: Number(h.engine.debug.targetY) }
}

describe('keeper engine: save geometry and reaction guards', () => {
  test('torso-only keeper: the capsule saves every kick while both gloves are 0.9 m above the ball', () => {
    const h = setup(11)
    h.engine.startShootout()
    // pointerPose puts the torso at x * 0.6 hanging 0.2..0.95 m below the pointer, gloves at the pointer.
    run(h, (hh) => {
      const t = target(hh)
      hh.engine.setPointer({ x: t.x / 0.6, y: t.y + 0.9 })
    })
    expect(h.kicks).toHaveLength(5)
    expect(h.kicks.map((k) => k.outcome)).toEqual(['save', 'save', 'save', 'save', 'save'])
    expect(h.kicks.map((k) => k.part)).toEqual(['torso', 'torso', 'torso', 'torso', 'torso'])
    expect(h.kicks.every((k) => !k.punch)).toBe(true) // only gloves punch
    const saves = rec.events.filter((e) => e.event_type === 'SAVE')
    expect(saves.map((s) => s.metrics.part)).toEqual(['torso', 'torso', 'torso', 'torso', 'torso'])
    expect(h.scene.calls.filter((c) => c.name === 'flashSave').map((c) => c.args[1])).toEqual([
      'torso',
      'torso',
      'torso',
      'torso',
      'torso',
    ])
  })

  test('a glove swept through the ball path within one update saves (glove motion is interpolated)', () => {
    // For side kicks, park one glove 1.5 m below the target (other glove 0.6 m to the side, torso clear),
    // then in the update where the ball is ~0.45 m out, jump it to 1.5 m above. Both end poses miss the
    // ball; only the swept, interpolated glove meets it.
    const h = setup(11)
    h.engine.startShootout()
    const swung: number[] = []
    let swingKick = -1
    run(h, (hh) => {
      const t = target(hh)
      const kick = lastPhase(hh)?.kick ?? 0
      if (Math.abs(t.x) <= 0.6) {
        hh.engine.setPointer(FAR)
        return
      }
      // Left glove (pointer - 0.3) for targets on the left, right glove for the right: torso stays > 0.42 m off.
      const px = t.x < 0 ? t.x + 0.3 : t.x - 0.3
      const ballZ = Number(hh.engine.debug.ballZ)
      const inFlight = sinceTelegraph(hh) > TELEGRAPH_MS && hh.kicks.length === kick
      if (swingKick === kick || (inFlight && ballZ > -0.45 && ballZ < 0)) {
        if (swingKick !== kick) swung.push(kick)
        swingKick = kick
        hh.engine.setPointer({ x: px, y: t.y + 1.5 })
      } else {
        hh.engine.setPointer({ x: px, y: t.y - 1.5 })
      }
    })
    const side = h.kicks.filter((k) => swung.includes(k.kick))
    expect(side.length).toBeGreaterThanOrEqual(2)
    for (const k of side) {
      expect(k.outcome, `kick ${k.kick}`).toBe('save')
      expect(['left', 'right']).toContain(k.part)
    }
    // Central kicks against the parked-far keeper are goals, so the saves above are not free.
    expect(h.kicks.filter((k) => !swung.includes(k.kick)).every((k) => k.outcome === 'goal')).toBe(true)
  })

  test('a jump to the target 50 ms after the telegraph is never timed under the 100 ms floor', () => {
    const h = setup(11)
    h.engine.startShootout()
    run(h, perfectKeeper(50))
    expect(h.kicks).toHaveLength(5)
    expect(h.kicks.every((k) => k.outcome === 'save')).toBe(true)
    // The glove was still at the telegraph and moved at ~50 ms. Without the floor that would read as a
    // ~50-67 ms reaction. With it, the reaction is either dropped (velocity decayed under the threshold
    // by 100 ms) or clamped to the first frame at or past 100 ms.
    const r = h.kicks.map((k) => k.reactionMs)
    for (const ms of r) {
      if (ms === null) continue
      expect(ms).toBeGreaterThanOrEqual(100)
      expect(ms).toBeLessThan(100 + DT + 1)
    }
    expect(r.filter((ms) => ms === null).length).toBeGreaterThanOrEqual(1)
    const ev = rec.events.filter((e) => e.event_type === 'SAVE').map((e) => e.reaction_ms)
    expect(ev).toEqual(r)
  })

  test('a glove already moving fast through the 100 ms mark is not a reaction (must slow down first)', () => {
    const h = setup(23)
    h.engine.startShootout()
    let jiggle = 0
    run(h, (hh) => {
      const p = lastPhase(hh)
      const s = sinceTelegraph(hh)
      if (p?.phase === 'runup' || (s >= 0 && s < 200)) {
        jiggle++
        hh.engine.setPointer({ x: jiggle % 2 === 0 ? -0.5 : 0.5, y: 1.2 })
      } else if (s >= 200) {
        hh.engine.setPointer(target(hh))
      } else {
        hh.engine.setPointer(READY)
      }
    })
    expect(h.kicks).toHaveLength(5)
    expect(h.kicks.map((k) => k.reactionMs)).toEqual([null, null, null, null, null])
    expect(h.kicks.every((k) => k.peakVelocity > 5)).toBe(true)
  })

  test('for a side kick, a first move the wrong way is not the reaction; the later move toward the ball is', () => {
    const h = setup(11)
    h.engine.startShootout()
    const targets: { x: number; y: number }[] = []
    run(h, (hh) => {
      const t = target(hh)
      const s = sinceTelegraph(hh)
      targets[lastPhase(hh)?.kick ?? 0] = t
      if (s >= 300) hh.engine.setPointer(t)
      else if (s >= 150) hh.engine.setPointer({ x: -t.x, y: t.y })
      else hh.engine.setPointer(READY)
    })
    expect(h.kicks).toHaveLength(5)
    const sideKicks = h.kicks.filter((k) => Math.abs(targets[k.kick].x) > 0.6)
    const centreKicks = h.kicks.filter((k) => Math.abs(targets[k.kick].x) <= 0.6)
    expect(sideKicks.length).toBeGreaterThanOrEqual(2)
    for (const k of sideKicks) {
      expect(k.reactionMs, `kick ${k.kick} x=${targets[k.kick].x}`).not.toBeNull()
      expect(k.reactionMs!).toBeGreaterThanOrEqual(300)
      expect(k.reactionMs!).toBeLessThan(350)
    }
    // A central kick accepts any direction, so the first move counts.
    for (const k of centreKicks) {
      expect(k.reactionMs).not.toBeNull()
      expect(k.reactionMs!).toBeGreaterThanOrEqual(150)
      expect(k.reactionMs!).toBeLessThan(200)
    }
  })
})

describe('keeper engine: telemetry', () => {
  test('TICKs are buffered and only dispatched on flushTelemetry or the 2.5 s auto flush', () => {
    const h = setup(5)
    h.engine.startShootout()
    h.engine.setPointer(FAR)
    const ticks = () => rec.events.filter((e) => e.event_type === 'TICK').length
    for (let i = 0; i < 60; i++) h.engine.update(DT) // 1 s: 5 ticks queued
    expect(ticks()).toBe(0)
    h.engine.flushTelemetry()
    const afterManual = ticks()
    expect(afterManual).toBeGreaterThanOrEqual(4)
    expect(afterManual).toBeLessThanOrEqual(5)
    h.engine.flushTelemetry()
    expect(ticks()).toBe(afterManual) // nothing left to send

    // The auto flush fires once, at 2.5 s since the shootout started, sending a batch.
    const changes: { frame: number; count: number }[] = []
    let prev = ticks()
    for (let i = 60; i < 60 * 4; i++) {
      h.engine.update(DT)
      const n = ticks()
      if (n !== prev) changes.push({ frame: i + 1, count: n - prev })
      prev = n
    }
    expect(changes).toHaveLength(1)
    expect(changes[0].frame * DT).toBeGreaterThanOrEqual(2500 - 1)
    expect(changes[0].frame * DT).toBeLessThan(2500 + DT + 1)
    expect(changes[0].count).toBeGreaterThanOrEqual(6)
    // Ticks carry the 5 Hz pose summary.
    const tick = rec.events.find((e) => e.event_type === 'TICK')!
    expect(tick.metrics.summary).toBeUndefined()
    expect(tick.metrics.leftX).toBeCloseTo(FAR.x - 0.3, 3)
    expect(tick.player_id).toBe(localStorage.getItem('motion-sports.player-id'))
  })

  test('no events or scene calls after dispose()', () => {
    const h = setup(5)
    h.engine.startShootout()
    h.engine.setPointer(FAR)
    for (let i = 0; i < 100; i++) h.engine.update(DT)
    h.engine.dispose() // flushes pending ticks
    const nEvents = rec.events.length
    const nCalls = h.scene.calls.length
    expect(nEvents).toBeGreaterThan(0)

    h.engine.startShootout()
    h.engine.setPointer({ x: 0, y: 1 })
    h.engine.onPoseFrame(bodyFrame(5000, { bx: 0, by: 0 }, { bx: 0, by: 0 }))
    for (let i = 0; i < 60 * 40; i++) h.engine.update(DT)
    h.engine.flushTelemetry()
    h.engine.dispose()

    expect(rec.events.length).toBe(nEvents)
    expect(h.scene.calls.length).toBe(nCalls)
    expect(h.kicks).toHaveLength(0)
    expect(h.ends).toHaveLength(0)
  })
})

describe('keeper engine: camera path', () => {
  test('body frames with the wrists on the target save via keeperPoseFromBody; lost tracking eases to null', () => {
    const h = setup(11, true)
    h.engine.startShootout()
    let t = 10_000
    const readyL = goalToBody(-0.4, 0.3)
    const readyR = goalToBody(0.4, 0.3)
    run(
      h,
      (hh) => {
        const p = lastPhase(hh)
        const tf = hh.phases.filter((q) => q.phase === 'telegraph' && q.kick === p?.kick).pop()?.frame
        const onTarget = p && tf !== undefined && p.phase !== 'idle' && p.phase !== 'runup' && (hh.frame - tf) * DT >= 150
        if (onTarget) {
          const tgt = goalToBody(Number(hh.engine.debug.targetX), Number(hh.engine.debug.targetY))
          hh.engine.onPoseFrame(bodyFrame(t, tgt, tgt))
        } else {
          hh.engine.onPoseFrame(bodyFrame(t, readyL, readyR))
        }
        t += DT
      },
      (hh) => hh.kicks.length >= 3,
    )
    expect(h.kicks).toHaveLength(3)
    for (const k of h.kicks) {
      expect(k.outcome).toBe('save')
      expect(['left', 'right', 'torso']).toContain(k.part)
      // Wrists jump onto the target 150 ms after the telegraph: the body-velocity path times it.
      expect(k.reactionMs).not.toBeNull()
      expect(k.reactionMs!).toBeGreaterThanOrEqual(150)
      expect(k.reactionMs!).toBeLessThan(200)
    }
    const saves = rec.events.filter((e) => e.event_type === 'SAVE')
    expect(saves).toHaveLength(3)
    expect(saves.every((s) => s.metrics.source === 'pose')).toBe(true)
    expect(h.engine.debug.tracked).toBe('yes')

    // The scene gets the tracked pose: gloves on the goal plane near the ready / target spots.
    const lastKeeper = h.scene.last('setKeeper')!.args[0] as { tracked: boolean; left: { z: number } } | null
    expect(lastKeeper).not.toBeNull()
    expect(lastKeeper!.tracked).toBe(true)
    expect(lastKeeper!.left.z).toBe(0)

    // Lose the body: the pose is held through the 400 ms grace, then the scene is handed null.
    h.engine.onPoseFrame(null)
    const keeperAt: (unknown | null)[] = []
    for (let i = 0; i < 40; i++) {
      h.engine.update(DT)
      keeperAt.push(h.scene.last('setKeeper')!.args[0])
    }
    expect(h.engine.debug.tracked).toBe('no')
    // 300 ms after loss: still drawn.
    expect(keeperAt[Math.floor(300 / DT) - 1]).not.toBeNull()
    // 500 ms after loss: gloves ease to the ready pose.
    expect(keeperAt[Math.ceil(500 / DT) - 1]).toBeNull()
    const firstNull = keeperAt.findIndex((k) => k === null)
    expect((firstNull + 1) * DT).toBeGreaterThan(400)
    expect((firstNull + 1) * DT).toBeLessThan(400 + 2 * DT)

    // Tracking resumes: the scene gets a pose again on the next update.
    h.engine.onPoseFrame(bodyFrame(t + 2000, readyL, readyR))
    h.engine.update(DT)
    expect(h.scene.last('setKeeper')!.args[0]).not.toBeNull()
  })
})
