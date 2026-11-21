// Archery engine tests: mouse path through a full round, let-down, restart, telemetry shape.
// Run: node --test tests/archery/engine.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createArcheryEngine } from '../../src/sports/archery/engine.ts'
import {
  ARROWS_PER_ROUND,
  TARGET_CENTER,
  type ArcheryEngine,
  type ArcheryEventInput,
  type ArcheryMotionEvent,
  type ArcheryPhase,
  type ArcheryScene,
  type ArcheryTelemetry,
  type Vec2,
} from '../../src/sports/archery/types.ts'

function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface StubScene extends ArcheryScene {
  calls: { name: string; args: unknown[] }[]
  count(name: string): number
}

function stubScene(): StubScene {
  const calls: { name: string; args: unknown[] }[] = []
  const rec =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push({ name, args })
    }
  return {
    calls,
    count: (name) => calls.filter((c) => c.name === name).length,
    canvas: null as unknown as HTMLCanvasElement,
    resize: rec('resize'),
    setBow: rec('setBow'),
    setReticle: rec('setReticle'),
    setTarget: rec('setTarget'),
    setWind: rec('setWind'),
    setArrow: rec('setArrow'),
    stickArrow: rec('stickArrow'),
    missArrow: rec('missArrow'),
    setFollowCam: rec('setFollowCam'),
    shake: rec('shake'),
    screenToTarget: (x: number, y: number) => ({ x, y }),
    reset: rec('reset'),
    update: rec('update'),
    render: rec('render'),
    dispose: rec('dispose'),
  }
}

interface StubTelemetry extends ArcheryTelemetry {
  /** Everything dispatched, in order (emits and flushed ticks). */
  sent: ArcheryMotionEvent[]
  rounds: number
}

function stubTelemetry(): StubTelemetry {
  let pending: ArcheryEventInput[] = []
  let n = 0
  const t: StubTelemetry = {
    playerId: 'p',
    sessionId: 's',
    sent: [],
    rounds: 0,
    startRound() {
      t.rounds++
    },
    emit(input) {
      const e: ArcheryMotionEvent = {
        event_id: String(n++),
        session_id: 's',
        player_id: 'p',
        sport: 'ARCHERY',
        event_ts: new Date(0).toISOString(),
        round_ms: 0,
        event_type: input.event_type,
        peak_velocity: input.peak_velocity ?? null,
        reaction_ms: input.reaction_ms ?? null,
        accuracy_score: input.accuracy_score ?? null,
        symmetry_ratio: input.symmetry_ratio ?? null,
        metrics: input.metrics ?? {},
      }
      t.sent.push(e)
      return e
    },
    queueTick(input) {
      pending.push({ ...input, event_type: 'TICK' })
    },
    flush() {
      const k = pending.length
      for (const p of pending) t.emit(p)
      pending = []
      return k
    },
  }
  return t
}

function setup() {
  const scene = stubScene()
  const telemetry = stubTelemetry()
  const engine = createArcheryEngine({ telemetry, rng: seeded(42), sway: false })
  engine.init(scene, null)
  return { scene, telemetry, engine }
}

const summaries = (t: StubTelemetry) => t.sent.filter((e) => e.event_type === 'TICK' && e.metrics.summary === true)
const releases = (t: StubTelemetry) => t.sent.filter((e) => e.event_type === 'ARROW_RELEASE')

/** Plays mouse arrows at `aim` with a full draw until the round ends. Returns the lowest timeScale seen. */
function playRound(engine: ArcheryEngine, aim: Vec2, maxFrames = 20000): number {
  let minScale = 1
  for (let i = 0; i < maxFrames && engine.phase !== 'ended'; i++) {
    const v = engine.view
    const drawing = engine.phase === 'aiming' && !(v.drawPhase === 'armed' && v.tension >= 1)
    engine.setMouse({ aim, drawing })
    engine.update(16)
    minScale = Math.min(minScale, engine.timeScale)
  }
  return minScale
}

function runUntil(engine: ArcheryEngine, phase: ArcheryPhase, aim: Vec2, maxFrames = 2000): void {
  for (let i = 0; i < maxFrames && engine.phase !== phase; i++) {
    engine.setMouse({ aim, drawing: false })
    engine.update(16)
  }
  assert.equal(engine.phase, phase)
}

test('mouse round: bullseyes, slow-mo, telemetry, round end', () => {
  const { scene, telemetry, engine } = setup()
  const phases: ArcheryPhase[] = []
  let ends = 0
  let endTotal = -1
  let shotCbs = 0
  let releaseCbs = 0
  engine.onPhase((p) => phases.push(p))
  engine.onShot(() => shotCbs++)
  engine.onRelease(() => releaseCbs++)
  engine.onRoundEnd((r) => {
    ends++
    endTotal = r.total
    assert.equal(r.shots.length, ARROWS_PER_ROUND)
    assert.ok(r.score >= r.total * 100)
  })

  engine.startRound()
  assert.equal(engine.phase, 'nock')
  const minScale = playRound(engine, { ...TARGET_CENTER })

  assert.equal(engine.phase, 'ended')
  assert.equal(engine.shots.length, ARROWS_PER_ROUND)
  assert.equal(engine.arrowIndex, ARROWS_PER_ROUND)
  for (let i = 0; i < 3; i++) {
    assert.equal(engine.shots[i].score, 10, `arrow ${i}`)
    assert.equal(engine.shots[i].bullseye, true)
    assert.equal(engine.shots[i].wind, 0)
    assert.equal(engine.shots[i].trigger, 'mouse')
    assert.equal(engine.shots[i].source, 'mouse')
  }
  for (const s of engine.shots) assert.ok(s.tension >= 0.99)

  // Bullseye slow-mo: time slowed, follow cam on then off, back to real time.
  assert.ok(minScale < 1, `timeScale dipped (${minScale})`)
  assert.ok(minScale >= 0.19)
  const follow = scene.calls.filter((c) => c.name === 'setFollowCam').map((c) => c.args[0])
  assert.ok(follow.includes(true))
  assert.equal(follow[follow.length - 1], false)
  assert.equal(engine.timeScale, 1)

  // Impacts reached the scene.
  assert.equal(scene.count('stickArrow') + scene.count('missArrow'), ARROWS_PER_ROUND)
  assert.ok(scene.count('stickArrow') >= 3)

  // Telemetry: 5 releases, then exactly one summary, last.
  const rel = releases(telemetry)
  assert.equal(rel.length, ARROWS_PER_ROUND)
  assert.equal(rel[0].accuracy_score, 100)
  assert.equal(rel[0].peak_velocity, null)
  assert.equal(rel[0].metrics.source, 'mouse')
  assert.equal(rel[0].metrics.bowHand, null)
  const sums = summaries(telemetry)
  assert.equal(sums.length, 1)
  const sum = sums[0]
  assert.equal(telemetry.sent.indexOf(sum), telemetry.sent.length - 1)
  assert.ok(telemetry.sent.indexOf(rel[4]) < telemetry.sent.indexOf(sum))
  const total = engine.shots.reduce((a, s) => a + s.score, 0)
  const counts = sum.metrics.counts as Record<string, unknown>
  assert.equal(counts.total, total)
  assert.equal(counts.arrows, ARROWS_PER_ROUND)
  assert.equal(sum.metrics.accuracyPct, Math.round((total / 50) * 100))
  assert.equal(sum.metrics.outcome, total >= 35 ? 'win' : 'loss')
  assert.equal(sum.metrics.bestSpeed, 50)

  // 5 Hz ticks while aiming were flushed.
  const ticks = telemetry.sent.filter((e) => e.event_type === 'TICK' && e.metrics.summary !== true)
  assert.ok(ticks.length > 5)
  assert.equal(ticks[0].metrics.source, 'mouse')

  // Callbacks.
  assert.equal(ends, 1)
  assert.equal(endTotal, total)
  assert.equal(shotCbs, ARROWS_PER_ROUND)
  assert.equal(releaseCbs, ARROWS_PER_ROUND)
  for (const p of ['nock', 'aiming', 'flight', 'impact', 'ended'] as const) assert.ok(phases.includes(p), p)
  assert.equal(phases.filter((p) => p === 'ended').length, 1)

  // Idle frames after the end send nothing more; flushTelemetry never adds a summary.
  const before = telemetry.sent.length
  for (let i = 0; i < 300; i++) engine.update(16)
  engine.flushTelemetry()
  assert.equal(telemetry.sent.length, before)
  assert.equal(ends, 1)
})

test('letting go before armed is a let-down, no shot', () => {
  const { telemetry, engine } = setup()
  const aim = { ...TARGET_CENTER }
  engine.startRound()
  runUntil(engine, 'aiming', aim)
  for (let i = 0; i < 20; i++) {
    engine.setMouse({ aim, drawing: true })
    engine.update(16)
  }
  assert.equal(engine.view.drawPhase, 'drawing')
  assert.ok(engine.view.tension > 0.2)
  for (let i = 0; i < 125; i++) {
    engine.setMouse({ aim, drawing: false })
    engine.update(16)
  }
  assert.equal(engine.phase, 'aiming')
  assert.equal(engine.shots.length, 0)
  assert.equal(releases(telemetry).length, 0)
  assert.equal(engine.view.tension, 0)
  assert.equal(engine.view.drawPhase, 'idle')
  assert.equal(engine.view.hint, 'Hold click or Space to draw, let go to shoot')
  engine.flushTelemetry()
  assert.equal(summaries(telemetry).length, 0)
})

test('startRound again resets the round', () => {
  const { scene, telemetry, engine } = setup()
  let ends = 0
  engine.onRoundEnd(() => ends++)
  engine.startRound()
  playRound(engine, { ...TARGET_CENTER })
  assert.equal(engine.phase, 'ended')
  const resets = scene.count('reset')

  engine.startRound()
  assert.equal(engine.phase, 'nock')
  assert.equal(engine.shots.length, 0)
  assert.equal(engine.arrowIndex, 0)
  assert.equal(engine.view.arrow, 0)
  assert.equal(scene.count('reset'), resets + 1)
  assert.equal(telemetry.rounds, 2)

  playRound(engine, { ...TARGET_CENTER })
  assert.equal(engine.shots.length, ARROWS_PER_ROUND)
  assert.equal(ends, 2)
  assert.equal(summaries(telemetry).length, 2)
})

test('odd input and lifecycle never throw', () => {
  const telemetry = stubTelemetry()
  const engine = createArcheryEngine({ telemetry, rng: seeded(1), sway: false })
  // Before init: no scene, no-op.
  engine.update(16)
  engine.update(NaN)
  engine.update(-5)
  engine.onPoseFrame(null)
  engine.setMouse({ aim: { x: NaN, y: Infinity }, drawing: true })
  engine.startRound()
  for (let i = 0; i < 200; i++) engine.update(16)
  assert.ok(typeof engine.debug.phase === 'string')
  engine.dispose()
  engine.update(16)
  engine.startRound()
  assert.equal(engine.phase, 'idle')
})

test('wind arrows move the target and report wind', () => {
  const { scene, engine } = setup()
  engine.startRound()
  playRound(engine, { ...TARGET_CENTER })
  const late = engine.shots.slice(3)
  assert.ok(late.every((s) => s.wind !== 0))
  const xs = scene.calls.filter((c) => c.name === 'setTarget').map((c) => (c.args[0] as Vec2).x)
  assert.ok(xs.some((x) => Math.abs(x - TARGET_CENTER.x) > 1e-3))
})
