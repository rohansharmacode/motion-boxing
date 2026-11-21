// Aero Bow draw/release detector tests. Run: node --test tests/archery/detector.test.ts
// Synthetic 30 fps BodyFrames: body space in shoulder widths (y down, mirror view), world joints built so the
// 3D elbow angles are what each pose asks for.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ARCHERY_TRACKER_FILTER, createArcheryDetector, stabilityScore } from '../../src/sports/archery/detector.ts'
import { ARM_HOLD_MS, ARM_TENSION } from '../../src/sports/archery/types.ts'
import type { ArcheryDetector, DrawSample, ReleaseInfo } from '../../src/sports/archery/types.ts'
import type { BodyFrame, Calibration, Hand, Joint } from '../../src/pose/types.ts'

const DT = 1000 / 30
const SW_WORLD = 0.36

const CAL: Calibration = {
  aspect: 4 / 3,
  shoulderWidth: 0.28,
  shoulderWidthWorld: SW_WORLD,
  torsoCenter: { x: 2 / 3, y: 0.55 },
  neutralNose: { x: 2 / 3, y: 0.38 },
}

interface P {
  x: number
  y: number
}

/** Pose in bow-relative terms, for a left bow hand (the bow arm on screen left). Mirrored for 'right'. */
interface Pose {
  bow: P
  draw: P
  /** 3D elbow angles, deg. */
  bowAng: number
  drawAng: number
}

/** Hands together in front of the chest, both elbows bent. Tension 0. */
const REST: Pose = { bow: { x: -0.15, y: 0.5 }, draw: { x: 0.15, y: 0.5 }, bowAng: 95, drawAng: 95 }

/** Full draw at tension T: bow arm straight out to the side, draw hand by the chin. */
function full(T: number): Pose {
  return { bow: { x: -1.2, y: 0 }, draw: { x: -1.2 + 0.5 + 1.1 * T, y: -0.15 }, bowAng: 172, drawAng: 45 }
}

const lerp = (a: number, b: number, u: number): number => a + (b - a) * u
const lerpP = (a: P, b: P, u: number): P => ({ x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u) })
const lerpPose = (a: Pose, b: Pose, u: number): Pose => ({
  bow: lerpP(a.bow, b.bow, u),
  draw: lerpP(a.draw, b.draw, u),
  bowAng: lerp(a.bowAng, b.bowAng, u),
  drawAng: lerp(a.drawAng, b.drawAng, u),
})

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface FrameOpts {
  side: Hand
  /** Uniform noise amplitude on every tracked joint, SW. */
  noise: number
  /** Extra noise on the bow wrist only, SW. */
  bowNoise: number
  /** Visibility of the wrists. */
  wristVis: number
  /** Player closer (> 1) or further: body coordinates and BodyFrame.scale scale together. */
  scale: number
}

function buildFrame(t: number, pose: Pose, rng: () => number, o: FrameOpts): BodyFrame {
  const blank = (): Joint => ({ x: 0, y: 0, z: 0, visibility: 0 })
  const body: Joint[] = Array.from({ length: 33 }, blank)
  const world: Joint[] = Array.from({ length: 33 }, blank)
  const n = (amp: number): number => (rng() * 2 - 1) * amp
  const mx = o.side === 'left' ? 1 : -1
  const bowW = o.side === 'left' ? 15 : 16
  const drawW = o.side === 'left' ? 16 : 15
  const put = (i: number, p: P, vis: number, extra = 0): void => {
    body[i] = { x: p.x * o.scale + n(o.noise) + n(extra), y: p.y * o.scale + n(o.noise) + n(extra), z: 0, visibility: vis }
  }
  put(0, { x: 0, y: -0.6 }, 0.99)
  put(11, { x: -0.5, y: 0 }, 0.99)
  put(12, { x: 0.5, y: 0 }, 0.99)
  put(bowW, { x: pose.bow.x * mx, y: pose.bow.y }, o.wristVis, o.bowNoise)
  put(drawW, { x: pose.draw.x * mx, y: pose.draw.y }, o.wristVis)
  // World: metres, same axes; z = 0 except the elbow, pushed back so the 3D elbow angle is as asked.
  for (const i of [0, 11, 12, 15, 16]) {
    const j = body[i]
    world[i] = { x: (j.x / o.scale) * SW_WORLD, y: (j.y / o.scale) * SW_WORLD, z: 0, visibility: j.visibility }
  }
  const elbow = (shoulder: number, wrist: number, elbowIdx: number, angDeg: number): void => {
    const s = world[shoulder]
    const w = world[wrist]
    const d = Math.hypot(w.x - s.x, w.y - s.y)
    const half = (Math.min(179.9, angDeg) * Math.PI) / 360
    const h = d / 2 / Math.tan(half)
    world[elbowIdx] = { x: (s.x + w.x) / 2, y: (s.y + w.y) / 2, z: h, visibility: 0.95 }
    const bs = body[shoulder]
    const bw = body[wrist]
    body[elbowIdx] = { x: (bs.x + bw.x) / 2, y: (bs.y + bw.y) / 2, z: 0, visibility: 0.95 }
  }
  const bowElbow = o.side === 'left' ? 13 : 14
  const drawElbow = o.side === 'left' ? 14 : 13
  const bowShoulder = o.side === 'left' ? 11 : 12
  const drawShoulder = o.side === 'left' ? 12 : 11
  elbow(bowShoulder, bowW, bowElbow, pose.bowAng)
  elbow(drawShoulder, drawW, drawElbow, pose.drawAng)
  return { t, body, world, neutralNose: { x: 0, y: -0.6 }, scale: o.scale, calibration: CAL }
}

class Sim {
  readonly det: ArcheryDetector
  readonly samples: DrawSample[] = []
  t = 1000
  pose: Pose = REST
  readonly o: FrameOpts
  private readonly rng: () => number

  constructor(opts: Partial<FrameOpts> & { seed?: number; det?: ArcheryDetector } = {}) {
    this.det = opts.det ?? createArcheryDetector()
    this.rng = mulberry32(opts.seed ?? 1)
    this.o = { side: 'left', noise: 0.003, bowNoise: 0, wristVis: 0.95, scale: 1, ...opts }
  }

  frame(pose: Pose = this.pose): DrawSample {
    this.t += DT
    const s = this.det.push(buildFrame(this.t, pose, this.rng, this.o))
    this.samples.push(s)
    return s
  }

  hold(ms: number): this {
    const n = Math.round(ms / DT)
    for (let i = 0; i < n; i++) this.frame()
    return this
  }

  /** Linear move from the current pose to `to` over ms (the last frame lands on `to`). */
  move(ms: number, to: Pose): this {
    const from = this.pose
    const n = Math.max(1, Math.round(ms / DT))
    for (let i = 1; i <= n; i++) this.frame(lerpPose(from, to, i / n))
    this.pose = to
    return this
  }

  nulls(ms: number): this {
    const n = Math.round(ms / DT)
    for (let i = 0; i < n; i++) {
      this.t += DT
      this.samples.push(this.det.push(null))
    }
    return this
  }

  /** Samples pushed from index `from` on. */
  since(from: number): DrawSample[] {
    return this.samples.slice(from)
  }

  get last(): DrawSample {
    return this.samples[this.samples.length - 1]
  }

  releases(from = 0): ReleaseInfo[] {
    return this.since(from).flatMap((s) => (s.release ? [s.release] : []))
  }

  /** Rest, then a 700 ms draw to tension T, then hold. */
  drawTo(T: number, holdMs: number): this {
    return this.hold(300).move(700, full(T)).hold(holdMs)
  }
}

const withDraw = (p: Pose, draw: P): Pose => ({ ...p, draw })

// ---------------------------------------------------------------------------------------------

test('tracker filter is lighter than goalkeeper (1.2 Hz, beta 0.12)', () => {
  assert.ok(ARCHERY_TRACKER_FILTER.minCutoff >= 1.2)
  assert.ok(ARCHERY_TRACKER_FILTER.beta >= 0.12)
  assert.ok(ARCHERY_TRACKER_FILTER.minCutoff > 1.2 || ARCHERY_TRACKER_FILTER.beta > 0.12)
  assert.ok(ARCHERY_TRACKER_FILTER.dCutoff >= 1)
})

test('stabilityScore: 100 when steady, 0 when shaky, monotonic', () => {
  assert.equal(stabilityScore(0), 100)
  assert.equal(stabilityScore(2), 100)
  assert.equal(stabilityScore(30), 0)
  assert.equal(stabilityScore(500), 0)
  assert.equal(stabilityScore(Number.NaN), 0)
  assert.equal(stabilityScore(-5), 100)
  let prev = Infinity
  for (let mm = 0; mm <= 40; mm += 0.5) {
    const s = stabilityScore(mm)
    assert.ok(s >= 0 && s <= 100)
    assert.ok(s <= prev)
    prev = s
  }
  assert.ok(stabilityScore(10) > 50 && stabilityScore(10) < 90)
})

test('idle at rest: tension 0, aim zero, no sway', () => {
  const sim = new Sim().hold(1000)
  for (const s of sim.samples) {
    assert.equal(s.tracked, true)
    assert.equal(s.phase, 'idle')
    assert.equal(s.tension, 0)
    assert.deepEqual(s.aim, { x: 0, y: 0 })
    assert.equal(s.swayMm, null)
    assert.equal(s.release, null)
  }
  for (const v of Object.values(sim.det.debug)) assert.ok(typeof v === 'string' || Number.isFinite(v))
})

test('full draw: drawing, then armed about ARM_HOLD_MS after tension passes ARM_TENSION', () => {
  const sim = new Sim().drawTo(0.85, 600)
  const s = sim.samples
  const above = s.findIndex((x) => x.tension > ARM_TENSION)
  const armed = s.findIndex((x) => x.phase === 'armed')
  const drawing = s.findIndex((x) => x.phase === 'drawing')
  assert.ok(drawing > 0 && drawing < above, 'drawing before tension passes ARM_TENSION')
  assert.ok(above > 0 && armed > above)
  const dt = s[armed].t - s[above].t
  assert.ok(dt >= ARM_HOLD_MS && dt < ARM_HOLD_MS + 2 * DT, `armed after ${dt} ms`)
  assert.ok(Math.abs(sim.last.tension - 0.85) < 0.02)
  assert.equal(sim.last.bowHand, 'left')
  assert.ok(sim.last.swayMm !== null && sim.last.swayMm >= 0 && sim.last.swayMm < 3)
  assert.ok(Math.hypot(sim.last.aim.x, sim.last.aim.y) < 0.02)
  assert.equal(sim.releases().length, 0)
  const tensions = s.slice(0, above).map((x) => x.tension)
  assert.ok(tensions.every((v) => v >= 0 && v <= 1))
})

test('snap release fires exactly once with the pre-release tension', () => {
  const sim = new Sim().drawTo(0.85, 700)
  const armedAt = sim.samples.find((s) => s.phase === 'armed')
  assert.ok(armedAt)
  const start = sim.samples.length
  const snapStartT = sim.t
  const p = sim.pose
  // Draw hand flies back (away from the bow) at about 5 SW/s, then rests far out.
  sim.move(120, withDraw(p, { x: p.draw.x + 0.6, y: p.draw.y - 0.05 })).hold(800)
  const rel = sim.releases(start)
  assert.equal(rel.length, 1)
  const r = rel[0]
  assert.equal(r.trigger, 'snap')
  assert.equal(r.bowHand, 'left')
  assert.ok(Math.abs(r.tension - 0.85) < 0.02, `tension ${r.tension}`)
  assert.ok(r.peakVelocity > 1.8 && r.peakVelocity < 8, `peak ${r.peakVelocity}`)
  assert.ok(r.t - snapStartT <= 100, `latency ${r.t - snapStartT} ms`)
  assert.ok(Math.abs(r.holdMs - (r.t - armedAt.t)) < 1e-9)
  assert.ok(r.holdMs > 300)
  assert.ok(r.bowElbowDeg > 160 && r.drawElbowDeg < 70, `elbows ${r.bowElbowDeg} ${r.drawElbowDeg}`)
  assert.ok(r.rmsSway >= 0 && r.rmsSwayMm < 3)
  assert.ok(Math.abs(r.rmsSwayMm - r.rmsSway * SW_WORLD * 1000) < 1e-9)
  assert.equal(r.stability, stabilityScore(r.rmsSwayMm))
  assert.ok(Math.hypot(r.aim.x, r.aim.y) < 0.02)
  // The release frame and everything after it report idle.
  const idx = sim.samples.findIndex((s) => s.release !== null)
  for (const s of sim.samples.slice(idx)) assert.equal(s.phase, 'idle')
})

test('drop release fires once', () => {
  const sim = new Sim().drawTo(0.8, 700)
  const start = sim.samples.length
  const p = sim.pose
  sim.move(150, withDraw(p, { x: p.draw.x, y: p.draw.y + 0.5 })).hold(600)
  const rel = sim.releases(start)
  assert.equal(rel.length, 1)
  assert.equal(rel[0].trigger, 'drop')
  assert.ok(Math.abs(rel[0].tension - 0.8) < 0.02)
  assert.ok(rel[0].peakVelocity > 1.5)
})

test('slow let-down never fires and returns to idle', () => {
  const sim = new Sim().drawTo(0.85, 700)
  assert.equal(sim.last.phase, 'armed')
  const start = sim.samples.length
  sim.move(1500, REST).hold(800)
  assert.equal(sim.releases(start).length, 0)
  assert.equal(sim.last.phase, 'idle')
  assert.equal(sim.det.debug.letdowns, 1)
})

test('fast let-down toward the bow hand never fires', () => {
  const sim = new Sim().drawTo(0.85, 700)
  const start = sim.samples.length
  const p = sim.pose
  // Draw hand rushes forward to the bow hand at about 3 SW/s.
  sim.move(450, withDraw(p, { x: -1.05, y: 0 })).hold(800)
  assert.equal(sim.releases(start).length, 0)
  assert.equal(sim.last.phase, 'idle')
})

test('lowering both arms is not a drop release', () => {
  const sim = new Sim().drawTo(0.85, 700)
  const start = sim.samples.length
  const p = sim.pose
  sim.move(350, { ...p, bow: { x: p.bow.x, y: p.bow.y + 1.5 }, draw: { x: p.draw.x, y: p.draw.y + 1.5 } }).hold(800)
  assert.equal(sim.releases(start).length, 0)
  assert.equal(sim.last.phase, 'idle')
})

test('still pulling past ARM_TENSION does not fire until the hand settles', () => {
  const sim = new Sim()
  sim.hold(300)
  // Bow arm out first, draw hand on the string next to it (tension 0).
  const start: Pose = { bow: { x: -1.2, y: 0 }, draw: { x: -0.95, y: -0.1 }, bowAng: 172, drawAng: 150 }
  sim.move(400, start).hold(300)
  // Pull at 2 SW/s (above the 1.8 snap speed, away from the bow) for a full second.
  const i0 = sim.samples.length
  sim.move(1000, { ...start, draw: { x: 1.05, y: -0.1 }, drawAng: 45 })
  const pull = sim.since(i0)
  const armedIdx = pull.findIndex((s) => s.phase === 'armed')
  assert.ok(armedIdx >= 0, 'armed while still pulling')
  assert.ok(pull.length - armedIdx >= 5, 'several armed frames while still pulling')
  assert.equal(sim.releases(i0).length, 0, 'no release while pulling')
  // Hold, then snap: now it fires.
  sim.hold(400)
  assert.equal(sim.releases(i0).length, 0)
  const i1 = sim.samples.length
  const p = sim.pose
  sim.move(120, withDraw(p, { x: p.draw.x + 0.6, y: p.draw.y })).hold(300)
  const rel = sim.releases(i1)
  assert.equal(rel.length, 1)
  assert.equal(rel[0].trigger, 'snap')
  assert.equal(rel[0].tension, 1)
})

test('jitter while armed (+-0.02 SW on every joint) never fires', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const sim = new Sim({ seed, noise: 0.02 })
    sim.drawTo(0.85, 4000)
    assert.equal(sim.releases().length, 0, `seed ${seed}`)
    assert.equal(sim.last.phase, 'armed', `seed ${seed}`)
  }
})

test('a real snap still fires reliably under the same jitter', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const sim = new Sim({ seed, noise: 0.02 }).drawTo(0.85, 900)
    const p = sim.pose
    sim.move(120, withDraw(p, { x: p.draw.x + 0.6, y: p.draw.y })).hold(300)
    const rel = sim.releases()
    assert.equal(rel.length, 1, `seed ${seed}`)
    assert.ok(Math.abs(rel[0].tension - 0.85) < 0.08, `seed ${seed} tension ${rel[0].tension}`)
  }
})

test('single-frame landmark glitches never fire', () => {
  const sim = new Sim().drawTo(0.85, 700)
  const start = sim.samples.length
  const p = sim.pose
  const glitches: P[] = [
    { x: 0.3, y: 0 },
    { x: 1.0, y: 0 },
    { x: 0, y: 0.4 },
    { x: 0.25, y: 0.25 },
  ]
  for (const g of glitches) {
    sim.frame(withDraw(p, { x: p.draw.x + g.x, y: p.draw.y + g.y }))
    sim.hold(500)
  }
  assert.equal(sim.releases(start).length, 0)
  assert.equal(sim.last.phase, 'armed')
  // Still releasable afterwards.
  sim.move(120, withDraw(p, { x: p.draw.x + 0.6, y: p.draw.y }))
  assert.equal(sim.releases(start).length, 1)
})

for (const side of ['left', 'right'] as const) {
  test(`${side} bow hand: detected, locked and reported on the release`, () => {
    const sim = new Sim({ side })
    sim.drawTo(0.9, 700)
    assert.equal(sim.last.phase, 'armed')
    assert.equal(sim.last.bowHand, side)
    const armed = sim.samples.filter((s) => s.phase !== 'idle')
    assert.ok(armed.slice(-10).every((s) => s.bowHand === side))
    const start = sim.samples.length
    const p = sim.pose
    sim.move(120, withDraw(p, { x: p.draw.x + 0.6, y: p.draw.y })).hold(300)
    const rel = sim.releases(start)
    assert.equal(rel.length, 1)
    assert.equal(rel[0].bowHand, side)
    assert.equal(rel[0].trigger, 'snap')
    // The learned hand survives reset() and breaks ties while idle.
    sim.det.reset()
    sim.move(600, REST).hold(300)
    assert.equal(sim.last.phase, 'idle')
    assert.equal(sim.last.bowHand, side)
  })
}

test('handedness from the elbow angles alone (wrists equally far out)', () => {
  // Bow on the right by angles, but both wrists the same distance from the torso centre.
  const sim = new Sim({ side: 'right' })
  const pose: Pose = { bow: { x: -0.95, y: 0 }, draw: { x: 0.95, y: -0.1 }, bowAng: 170, drawAng: 50 }
  sim.hold(200).move(500, pose).hold(600)
  assert.equal(sim.last.phase, 'armed')
  assert.equal(sim.last.bowHand, 'right')
  assert.equal(sim.det.debug.handFrom, 'angle')
})

test('tracking loss over 400 ms drops the draw; a short gap does not', () => {
  const short = new Sim().drawTo(0.85, 700)
  short.nulls(200)
  assert.equal(short.last.phase, 'armed')
  assert.equal(short.last.tracked, false)
  short.hold(500)
  assert.equal(short.last.phase, 'armed')
  const i = short.samples.length
  const p = short.pose
  short.move(120, withDraw(p, { x: p.draw.x + 0.6, y: p.draw.y })).hold(200)
  assert.equal(short.releases(i).length, 1, 'releases after re-settling')

  const long = new Sim().drawTo(0.85, 700)
  long.nulls(300)
  assert.equal(long.last.phase, 'armed')
  long.nulls(200)
  assert.equal(long.last.phase, 'idle')
  assert.equal(long.last.tension, 0)
  // Back at full draw: no new draw until the hands come together.
  long.hold(800)
  assert.ok(long.since(long.samples.length - 24).every((s) => s.phase === 'idle'))
  long.move(700, REST).hold(200).move(700, full(0.85)).hold(500)
  assert.equal(long.last.phase, 'armed')
  assert.equal(long.releases().length, 0)
})

test('untracked frames (wrists not visible) count as lost tracking', () => {
  const sim = new Sim().drawTo(0.85, 700)
  sim.o.wristVis = 0.2
  sim.hold(300)
  assert.equal(sim.last.tracked, false)
  assert.equal(sim.last.phase, 'armed')
  sim.hold(200)
  assert.equal(sim.last.phase, 'idle')
  assert.equal(sim.releases().length, 0)
})

test('release still fires when the draw hand leaves the frame mid-snap', () => {
  const sim = new Sim().drawTo(0.85, 700)
  const start = sim.samples.length
  const p = sim.pose
  // Two frames of a fast snap, then no pose at all.
  sim.frame(withDraw(p, { x: p.draw.x + 0.17, y: p.draw.y }))
  sim.nulls(300)
  const rel = sim.releases(start)
  assert.equal(rel.length, 1)
  assert.equal(rel[0].trigger, 'snap')
  assert.ok(Math.abs(rel[0].tension - 0.85) < 0.02)
})

test('no new draw after a release until the hands come back together', () => {
  const sim = new Sim().drawTo(0.85, 700)
  const p = sim.pose
  const after = withDraw(p, { x: p.draw.x + 0.6, y: p.draw.y })
  sim.move(120, after).hold(600)
  assert.equal(sim.releases().length, 1)
  // Hands still apart: stays idle, even across reset().
  sim.det.reset()
  sim.hold(1200)
  assert.ok(sim.since(sim.samples.length - 30).every((s) => s.phase === 'idle' && s.release === null))
  assert.equal(sim.det.debug.needsRecover, 1)
  // Hands together, then a new draw arms and releases again.
  sim.move(700, REST).hold(300)
  assert.equal(sim.det.debug.needsRecover, 0)
  sim.move(700, full(0.85)).hold(600)
  assert.equal(sim.last.phase, 'armed')
  const p2 = sim.pose
  sim.move(120, withDraw(p2, { x: p2.draw.x + 0.6, y: p2.draw.y })).hold(300)
  assert.equal(sim.releases().length, 2)
})

test('arms hanging at the sides is not a draw', () => {
  const down: Pose = { bow: { x: -0.7, y: 1.7 }, draw: { x: 0.7, y: 1.7 }, bowAng: 175, drawAng: 175 }
  // Lowering the arms from hands together may pass through a brief draw, but never arms or fires.
  const lowering = new Sim().hold(300).move(500, down).hold(1500)
  assert.ok(lowering.samples.every((s) => s.phase !== 'armed'))
  assert.equal(lowering.releases().length, 0)
  assert.equal(lowering.last.phase, 'idle')
  // Standing with the arms down (wrists 1.4 SW apart): idle throughout, tension reads 0.
  const sim = new Sim()
  sim.pose = down
  sim.hold(1500)
  assert.ok(sim.samples.every((s) => s.phase === 'idle' && s.tension === 0))
  // Raising the arms straight into a draw works without bringing the hands together.
  sim.move(500, full(0.85)).hold(600)
  assert.equal(sim.last.phase, 'armed')
})

test('tension does not change when the player steps closer', () => {
  const near = new Sim({ scale: 1.4 }).drawTo(0.75, 600)
  const far = new Sim({ scale: 1 }).drawTo(0.75, 600)
  assert.ok(Math.abs(near.last.tension - 0.75) < 0.02)
  assert.ok(Math.abs(near.last.tension - far.last.tension) < 0.02)
  assert.equal(near.last.phase, 'armed')
})

test('aim follows the tight-filtered bow wrist since arming, y up', () => {
  const sim = new Sim().drawTo(0.85, 700)
  assert.equal(sim.last.phase, 'armed')
  const p = sim.pose
  sim.move(500, { ...p, bow: { x: p.bow.x + 0.1, y: p.bow.y - 0.1 } }).hold(1500)
  assert.equal(sim.last.phase, 'armed')
  assert.ok(Math.abs(sim.last.aim.x - 0.1) < 0.015, `aim x ${sim.last.aim.x}`)
  assert.ok(Math.abs(sim.last.aim.y - 0.1) < 0.015, `aim y ${sim.last.aim.y}`)
  // Released aim is the pre-snap aim.
  const start = sim.samples.length
  const q = sim.pose
  sim.move(120, withDraw(q, { x: q.draw.x + 0.6, y: q.draw.y })).hold(200)
  const r = sim.releases(start)[0]
  assert.ok(r)
  assert.ok(Math.abs(r.aim.x - 0.1) < 0.015 && Math.abs(r.aim.y - 0.1) < 0.015)
})

test('a shaky bow arm scores lower stability than a steady one', () => {
  const shoot = (bowNoise: number): ReleaseInfo => {
    const sim = new Sim({ bowNoise, seed: 7 }).drawTo(0.85, 1200)
    const p = sim.pose
    sim.move(120, withDraw(p, { x: p.draw.x + 0.6, y: p.draw.y })).hold(200)
    const r = sim.releases()
    assert.equal(r.length, 1)
    return r[0]
  }
  const steady = shoot(0)
  const shaky = shoot(0.05)
  assert.ok(steady.stability > 95, `steady ${steady.stability}`)
  assert.ok(shaky.rmsSwayMm > steady.rmsSwayMm + 5, `sway ${steady.rmsSwayMm} vs ${shaky.rmsSwayMm}`)
  assert.ok(shaky.stability < steady.stability - 20)
})

test('duplicate frames are ignored and never repeat a release', () => {
  const det = createArcheryDetector()
  const sim = new Sim({ det }).drawTo(0.85, 700)
  const rng = mulberry32(3)
  const p = sim.pose
  sim.move(120, withDraw(p, { x: p.draw.x + 0.6, y: p.draw.y }))
  assert.equal(sim.releases().length, 1)
  const again = det.push(buildFrame(sim.t, sim.pose, rng, sim.o))
  assert.equal(again.release, null)
  const older = det.push(buildFrame(sim.t - 500, sim.pose, rng, sim.o))
  assert.equal(older.release, null)
})
