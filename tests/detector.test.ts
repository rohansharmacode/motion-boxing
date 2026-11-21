// Black-box tests for src/detector.ts, written from the DETECTOR SPEC only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDetector, DEFAULT_CONFIG } from '../src/detector.ts'
import { LM } from '../src/types.ts'
import type { Detector, DetectorOutput, Landmark, PoseFrame, PunchEvent } from '../src/types.ts'

type V3 = [number, number, number]

// Reference body: world metres, hip origin, y down, player's left is negative x.
const BODY: V3[] = [
  [0, -0.66, -0.05], // 0 nose
  [-0.015, -0.69, -0.04], [-0.03, -0.69, -0.04], [-0.045, -0.69, -0.04], // 1-3 left eye
  [0.015, -0.69, -0.04], [0.03, -0.69, -0.04], [0.045, -0.69, -0.04], // 4-6 right eye
  [-0.07, -0.67, 0.02], [0.07, -0.67, 0.02], // 7-8 ears
  [-0.02, -0.63, -0.04], [0.02, -0.63, -0.04], // 9-10 mouth
  [-0.19, -0.45, 0], [0.19, -0.45, 0], // 11-12 shoulders
  [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], // 13-16 elbows, wrists (computed)
  [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], // 17-22 hands (computed)
  [-0.12, 0, 0], [0.12, 0, 0], // 23-24 hips
  [-0.12, 0.42, 0], [0.12, 0.42, 0], // 25-26 knees
  [-0.12, 0.82, 0.02], [0.12, 0.82, 0.02], // 27-28 ankles
  [-0.12, 0.86, 0.06], [0.12, 0.86, 0.06], // 29-30 heels
  [-0.12, 0.88, -0.08], [0.12, 0.88, -0.08], // 31-32 foot index
]

const GUARD_L: V3 = [-0.1, -0.55, -0.18]
const GUARD_R: V3 = [0.1, -0.55, -0.18]
const JAB_END: V3 = [-0.05, -0.5, -0.58]
const HOOK_START: V3 = [0.42, -0.45, -0.25]
const HOOK_END: V3 = [-0.05, -0.47, -0.3]
const BLOCK_L: V3 = [-0.07, -0.7, -0.2]
const BLOCK_R: V3 = [0.07, -0.7, -0.2]
const T0 = 1000

interface FrameOpts {
  /** Landmark index to world position. Elbows and hand points follow the wrists. */
  move?: Partial<Record<number, V3>>
  /** Landmark index to visibility (default 1). */
  vis?: Partial<Record<number, number>>
  /** Returns a world offset in metres, applied to every coordinate. */
  noise?: () => number
  /** Negate every world x (and so image.x becomes 1 - image.x). */
  mirror?: boolean
}

function makeFrame(t: number, o: FrameOpts = {}): PoseFrame {
  const p: V3[] = BODY.map((b, i) => [...(o.move?.[i] ?? b)])
  const lw = o.move?.[LM.L_WRIST] ?? GUARD_L
  const rw = o.move?.[LM.R_WRIST] ?? GUARD_R
  p[LM.L_WRIST] = [...lw]
  p[LM.R_WRIST] = [...rw]
  // Elbows: midway between shoulder and wrist, a little lower and outward.
  const elbow = (s: V3, w: V3, out: number): V3 => [(s[0] + w[0]) / 2 + out * 0.04, (s[1] + w[1]) / 2 + 0.06, (s[2] + w[2]) / 2]
  p[LM.L_ELBOW] = elbow(p[LM.L_SHOULDER], lw, -1)
  p[LM.R_ELBOW] = elbow(p[LM.R_SHOULDER], rw, 1)
  for (const i of [17, 19, 21]) p[i] = [lw[0], lw[1] - 0.02, lw[2] - 0.02]
  for (const i of [18, 20, 22]) p[i] = [rw[0], rw[1] - 0.02, rw[2] - 0.02]
  const n = o.noise ?? (() => 0)
  const world: Landmark[] = p.map(([x, y, z], i) => ({
    x: (x + n()) * (o.mirror ? -1 : 1),
    y: y + n(),
    z: z + n(),
    visibility: o.vis?.[i] ?? 1,
  }))
  const image: Landmark[] = world.map((w) => ({ x: 0.5 + 0.8 * w.x, y: 0.55 + 0.8 * w.y, z: 0.8 * w.z, visibility: w.visibility }))
  return { t, image, world }
}

/** Tiny seeded PRNG (mulberry32), returns 0 to 1. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let r = Math.imul(a ^ (a >>> 15), 1 | a)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

/** Keyframe at `at` ms from motion start. Missing wrists keep the previous key's value. */
interface Key { at: number; l?: V3; r?: V3 }

interface MotionOpts {
  fps?: number
  t0?: number
  /** Add deterministic plus or minus 3 ms timing jitter. */
  timeJitter?: boolean
  /** Deterministic position jitter amplitude in metres. */
  posJitter?: number
  seed?: number
  vis?: Partial<Record<number, number>>
  move?: Partial<Record<number, V3>>
  mirror?: boolean
}

const smooth = (u: number): number => u * u * (3 - 2 * u)
const lerp = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]

/** Interpolates the wrists between keyframes with smoothstep easing and emits frames. */
function motion(keys: Key[], o: MotionOpts = {}): PoseFrame[] {
  const full: { at: number; l: V3; r: V3 }[] = []
  for (const k of keys) {
    const prev = full[full.length - 1]
    full.push({ at: k.at, l: k.l ?? prev?.l ?? GUARD_L, r: k.r ?? prev?.r ?? GUARD_R })
  }
  const end = full[full.length - 1].at
  const rand = prng(o.seed ?? 1)
  const amp = o.posJitter ?? 0
  const noise = amp > 0 ? () => (rand() * 2 - 1) * amp : undefined
  const step = 1000 / (o.fps ?? 30)
  const frames: PoseFrame[] = []
  for (let i = 0; i * step <= end; i++) {
    const rel = i === 0 || !o.timeJitter ? i * step : i * step + (rand() * 2 - 1) * 3
    const s = Math.min(Math.max(rel, 0), end)
    let k = 0
    while (k < full.length - 2 && full[k + 1].at < s) k++
    const a = full[k]
    const b = full[Math.min(k + 1, full.length - 1)]
    const u = b.at > a.at ? smooth(Math.min(Math.max((s - a.at) / (b.at - a.at), 0), 1)) : 1
    const move = { ...o.move, [LM.L_WRIST]: lerp(a.l, b.l, u), [LM.R_WRIST]: lerp(a.r, b.r, u) }
    frames.push(makeFrame((o.t0 ?? T0) + rel, { move, vis: o.vis, noise, mirror: o.mirror }))
  }
  return frames
}

/** Feeds every frame, checks outputs are finite, collects punches and blocking per frame. */
function run(d: Detector, frames: (PoseFrame | null)[]) {
  const outs: DetectorOutput[] = []
  for (const f of frames) {
    const out = d.update(f)
    for (const [k, v] of Object.entries(out.debug)) assert.ok(Number.isFinite(v), `debug.${k} is ${v}`)
    for (const p of out.punches) assert.ok(Number.isFinite(p.speed) && Number.isFinite(p.t), 'punch has non-finite values')
    outs.push(out)
  }
  const punches: PunchEvent[] = outs.flatMap((o) => o.punches)
  const blocking = outs.map((o) => o.blocking)
  const times = frames.map((f) => (f ? f.t : -1))
  return { outs, punches, blocking, times }
}

/** Clear left jab starting `start` ms into the motion: 150 ms out, 100 ms hold, 250 ms back. */
const jabKeys = (start: number): Key[] => [
  { at: 0 }, { at: start }, { at: start + 150, l: JAB_END }, { at: start + 250 }, { at: start + 500, l: GUARD_L }, { at: start + 800 },
]
/** Clear right hook: hold at the start point, sweep in 170 ms, return over 300 ms. */
const hookKeys: Key[] = [
  { at: 0, r: HOOK_START }, { at: 400 }, { at: 570, r: HOOK_END }, { at: 670 }, { at: 970, r: GUARD_R }, { at: 1300 },
]
const blockHold = (ms: number): Key[] => [{ at: 0, l: BLOCK_L, r: BLOCK_R }, { at: ms }]

function assertOne(punches: PunchEvent[], type: string, hand: string): PunchEvent {
  assert.equal(punches.length, 1, `expected 1 punch, got ${JSON.stringify(punches)}`)
  assert.equal(punches[0].type, type)
  assert.equal(punches[0].hand, hand)
  return punches[0]
}

test('0. public API: DEFAULT_CONFIG holds finite numbers and createDetector accepts overrides', () => {
  for (const [k, v] of Object.entries(DEFAULT_CONFIG)) if (typeof v === 'number') assert.ok(Number.isFinite(v), k)
  assert.equal(createDetector({}).update(null).blocking, false)
})

test('1. idle guard for 2 s with 0.01 m jitter: no punches, never blocking', () => {
  for (const [fps, seed] of [[30, 1], [30, 7], [60, 3], [15, 9]]) {
    const r = run(createDetector(), motion([{ at: 0 }, { at: 2000 }], { fps, seed, posJitter: 0.01, timeJitter: true }))
    assert.equal(r.punches.length, 0, `fps ${fps} seed ${seed}`)
    assert.ok(r.blocking.every((b) => !b), `fps ${fps} seed ${seed}`)
  }
})

test('2. clear left jab counts exactly one left jab', () => {
  const p = assertOne(run(createDetector(), motion(jabKeys(300), { timeJitter: true })).punches, 'jab', 'left')
  assert.ok(p.speed > 0)
  assert.ok(p.t >= T0 + 300 && p.t <= T0 + 550, `t ${p.t}`)
})

test('3. clear right hook counts exactly one right hook', () => {
  const p = assertOne(run(createDetector(), motion(hookKeys, { timeJitter: true })).punches, 'hook', 'right')
  assert.ok(p.speed > 0)
  assert.ok(p.t >= T0 + 400 && p.t <= T0 + 770, `t ${p.t}`)
})

test('4. retraction only (jab return, hook pulled back outward) never counts', () => {
  const jabBack: Key[] = [{ at: 0, l: JAB_END }, { at: 400 }, { at: 550, l: GUARD_L }, { at: 950 }]
  assert.equal(run(createDetector(), motion(jabBack)).punches.length, 0)
  const hookBack: Key[] = [{ at: 0, r: HOOK_END }, { at: 400 }, { at: 570, r: HOOK_START }, { at: 970 }]
  assert.equal(run(createDetector(), motion(hookBack)).punches.length, 0)
})

test('5. slow jab and slow hook (1.2 s each way) do not count', () => {
  const slowJab: Key[] = [{ at: 0 }, { at: 300 }, { at: 1500, l: JAB_END }, { at: 1700 }, { at: 2900, l: GUARD_L }, { at: 3200 }]
  assert.equal(run(createDetector(), motion(slowJab)).punches.length, 0)
  const slowHook: Key[] = [{ at: 0, r: HOOK_START }, { at: 400 }, { at: 1600, r: HOOK_END }, { at: 1800 }, { at: 3000, r: GUARD_R }, { at: 3300 }]
  assert.equal(run(createDetector(), motion(slowHook)).punches.length, 0)
})

test('6. two clear left jabs 600 ms apart with full return count twice', () => {
  const keys = [...jabKeys(300).slice(0, 5), ...jabKeys(900).slice(1)]
  const { punches } = run(createDetector(), motion(keys))
  assert.equal(punches.length, 2, JSON.stringify(punches))
  assert.ok(punches.every((p) => p.type === 'jab' && p.hand === 'left'))
  assert.ok(Math.abs(punches[1].t - punches[0].t - 600) < 150)
})

test('7. double-tap without returning to guard counts at most one jab', () => {
  const half: V3 = [-0.07, -0.52, -0.42]
  const keys: Key[] = [
    { at: 0 }, { at: 300 }, { at: 450, l: JAB_END }, { at: 530, l: half }, { at: 610, l: JAB_END }, { at: 700 }, { at: 950, l: GUARD_L }, { at: 1250 },
  ]
  const { punches } = run(createDetector(), motion(keys))
  assert.ok(punches.length <= 1, JSON.stringify(punches))
  assert.ok(punches.every((p) => p.type === 'jab' && p.hand === 'left'))
})

test('8. the same clear jab counts once at 15, 30 and 60 fps', () => {
  for (const fps of [15, 30, 60]) {
    const { punches } = run(createDetector(), motion(jabKeys(300), { fps, timeJitter: true }))
    assert.equal(punches.length, 1, `fps ${fps}: ${JSON.stringify(punches)}`)
    assert.equal(punches[0].hand, 'left')
  }
})

test('9. mirrored input gives the same punches (left jab, right hook)', () => {
  assertOne(run(createDetector(), motion(jabKeys(300), { mirror: true })).punches, 'jab', 'left')
  assertOne(run(createDetector(), motion(hookKeys, { mirror: true })).punches, 'hook', 'right')
})

test('10. block: guard to block over 400 ms then hold, and a still block from the start', () => {
  const keys: Key[] = [{ at: 0 }, { at: 300 }, { at: 700, l: BLOCK_L, r: BLOCK_R }, { at: 1300 }]
  const r = run(createDetector(), motion(keys))
  const hold = T0 + 700
  assert.equal(r.punches.length, 0, JSON.stringify(r.punches))
  r.times.forEach((t, i) => {
    // Tolerant lower bound: the hold timer may start while the hands settle at the end of the move.
    if (t < hold + 100) assert.equal(r.blocking[i], false, `blocking too early at hold + ${t - hold} ms`)
    if (t >= hold + 350) assert.equal(r.blocking[i], true, `not blocking at hold + ${t - hold} ms`)
  })
  const s = run(createDetector(), motion(blockHold(600)))
  s.times.forEach((t, i) => {
    if (t < T0 + 200) assert.equal(s.blocking[i], false, `still block: too early at ${t - T0} ms`)
    if (t >= T0 + 350) assert.equal(s.blocking[i], true, `still block: not blocking at ${t - T0} ms`)
  })
})

test('11. guard held for 1 s is not a block', () => {
  const r = run(createDetector(), motion([{ at: 0 }, { at: 1000 }]))
  assert.ok(r.blocking.every((b) => !b))
  assert.equal(r.punches.length, 0)
})

test('12. jab thrown from a held block ends the block and counts once', () => {
  const keys: Key[] = [
    { at: 0, l: BLOCK_L, r: BLOCK_R }, { at: 600 }, { at: 730, l: [-0.05, -0.55, -0.62] }, { at: 830 }, { at: 1100, l: GUARD_L, r: GUARD_R }, { at: 1400 },
  ]
  const r = run(createDetector(), motion(keys))
  assert.ok(r.times.some((t, i) => t < T0 + 600 && r.blocking[i]), 'block was never held')
  const p = assertOne(r.punches, 'jab', 'left')
  r.outs.forEach((o, i) => {
    if (o.punches.length > 0) assert.equal(o.blocking, false, 'punch reported while blocking')
    if (r.times[i] >= p.t) assert.equal(o.blocking, false, 'still blocking after the jab')
  })
})

test('13. null frames, low visibility and degenerate shoulders: no punches, no NaN, no throw', () => {
  const d = createDetector()
  const nulls = run(d, [null, null, null, ...motion([{ at: 0 }, { at: 300 }]), null, null])
  assert.equal(nulls.punches.length, 0)
  assert.ok(nulls.blocking.every((b) => !b))
  // A null frame drops a held block at once.
  const held = run(createDetector(), [...motion(blockHold(600)), null])
  assert.equal(held.blocking[held.blocking.length - 1], false)
  const lowVis = run(createDetector(), motion(jabKeys(300), { vis: { [LM.L_WRIST]: 0.2 } }))
  assert.equal(lowVis.punches.length, 0)
  const flat: V3 = [0, -0.45, 0]
  run(createDetector(), motion(jabKeys(300), { move: { [LM.L_SHOULDER]: flat, [LM.R_SHOULDER]: flat } }))
})

test('14. a 500 ms gap, then the wrist reappears at full extension: no punch', () => {
  const before = motion([{ at: 0 }, { at: 1000 }])
  const after = motion([{ at: 0, l: JAB_END }, { at: 500 }], { t0: T0 + 1500 })
  assert.equal(run(createDetector(), [...before, ...after]).punches.length, 0)
})

test('15. reset() clears block state', () => {
  const d = createDetector()
  const frames = motion(blockHold(600))
  const r = run(d, frames)
  assert.equal(r.blocking[r.blocking.length - 1], true, 'block not reached before reset')
  d.reset()
  const t = frames[frames.length - 1].t
  const move = { [LM.L_WRIST]: BLOCK_L, [LM.R_WRIST]: BLOCK_R }
  assert.equal(d.update(makeFrame(t + 33, { move })).blocking, false, 'block survived reset')
  assert.equal(d.update(makeFrame(t + 66)).blocking, false)
})
