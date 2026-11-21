// Synthetic pose sequences for the boxing detector: a jab must register, guard and raising the hands must not.
import { describe, expect, test } from 'vitest'
import { createBoxingDetector } from '../../src/sports/boxing/detector.ts'
import { createCalibrator } from '../../src/pose/calibration.ts'
import type { BodyFrame, Calibration, Joint, PoseFrame } from '../../src/pose/types.ts'

type V3 = [number, number, number]
interface Arm {
  /** body-space wrist (shoulder widths, y down) */
  wrist2d: [number, number]
  elbow2d: [number, number]
  /** world metres, hip origin, y down, smaller z is closer to the camera */
  elbowW: V3
  wristW: V3
}

const CAL: Calibration = {
  aspect: 4 / 3,
  shoulderWidth: 0.25,
  shoulderWidthWorld: 0.36,
  torsoCenter: { x: 0.667, y: 0.45 },
  neutralNose: { x: 0.667, y: 0.3 },
}

const j = (x: number, y: number, z = 0, visibility = 0.99): Joint => ({ x, y, z, visibility })

/** Player's left arm is screen left (x < 0) in the mirror view. */
const LEFT_GUARD: Arm = { wrist2d: [-0.3, -0.5], elbow2d: [-0.55, 0.15], elbowW: [-0.2, -0.28, -0.08], wristW: [-0.1, -0.5, -0.18] }
const RIGHT_GUARD: Arm = { wrist2d: [0.3, -0.5], elbow2d: [0.55, 0.15], elbowW: [0.2, -0.28, -0.08], wristW: [0.1, -0.5, -0.18] }
const RIGHT_JAB: Arm = { wrist2d: [0.2, -0.25], elbow2d: [0.35, -0.15], elbowW: [0.17, -0.45, -0.27], wristW: [0.15, -0.45, -0.56] }
/** A short, lazy jab: the arm only opens to about 125 degrees but drives forward fast. */
const RIGHT_SHORT_JAB: Arm = { wrist2d: [0.22, -0.35], elbow2d: [0.45, -0.05], elbowW: [0.2, -0.36, -0.17], wristW: [0.12, -0.42, -0.42] }
const LEFT_DOWN: Arm = { wrist2d: [-0.6, 1.6], elbow2d: [-0.6, 0.8], elbowW: [-0.2, -0.17, 0], wristW: [-0.2, 0.1, -0.02] }
const RIGHT_DOWN: Arm = { wrist2d: [0.6, 1.6], elbow2d: [0.6, 0.8], elbowW: [0.2, -0.17, 0], wristW: [0.2, 0.1, -0.02] }

const lerp = (a: number, b: number, k: number): number => a + (b - a) * k
const lerpArm = (a: Arm, b: Arm, k: number): Arm => ({
  wrist2d: [lerp(a.wrist2d[0], b.wrist2d[0], k), lerp(a.wrist2d[1], b.wrist2d[1], k)],
  elbow2d: [lerp(a.elbow2d[0], b.elbow2d[0], k), lerp(a.elbow2d[1], b.elbow2d[1], k)],
  elbowW: a.elbowW.map((v, i) => lerp(v, b.elbowW[i], k)) as V3,
  wristW: a.wristW.map((v, i) => lerp(v, b.wristW[i], k)) as V3,
})

interface FrameOpts {
  /** BodyFrame.scale (live / calibrated shoulder width). */
  scale?: number
  /** Visibility of the right arm joints. */
  rightVis?: number
  /** World z of the right shoulder, m (negative = right shoulder forward, a rotated torso). */
  rightShoulderZ?: number
  /** Camera pitch, deg: rotates every world point about the x axis (a webcam tilted up or down). */
  pitch?: number
  /** Body-space nose y. */
  noseY?: number
  calibration?: Calibration
}

function frame(t: number, left: Arm, right: Arm, o: FrameOpts = {}): BodyFrame {
  const body = Array.from({ length: 33 }, () => j(0, 0, 0, 0))
  const world = Array.from({ length: 33 }, () => j(0, 0, 0, 0))
  const rz = o.rightShoulderZ ?? 0
  body[0] = j(0, o.noseY ?? -0.6)
  world[0] = j(0, -0.6, -0.1)
  body[11] = j(-0.5, 0)
  body[12] = j(0.5, 0)
  world[11] = j(-0.18, -0.45, -rz)
  world[12] = j(0.18, -0.45, rz)
  world[23] = j(-0.1, 0, 0)
  world[24] = j(0.1, 0, 0)
  const put = (arm: Arm, e: number, w: number, vis: number, dz: number): void => {
    body[e] = j(...arm.elbow2d, 0, vis)
    body[w] = j(...arm.wrist2d, 0, vis)
    world[e] = j(arm.elbowW[0], arm.elbowW[1], arm.elbowW[2] + dz, vis)
    world[w] = j(arm.wristW[0], arm.wristW[1], arm.wristW[2] + dz, vis)
  }
  put(left, 13, 15, 0.99, -rz)
  put(right, 14, 16, o.rightVis ?? 0.99, rz)
  if (o.rightVis !== undefined) body[12] = j(0.5, 0, 0, Math.max(o.rightVis, 0.99))
  if (o.pitch) {
    const a = (o.pitch * Math.PI) / 180
    const c = Math.cos(a)
    const sn = Math.sin(a)
    for (const p of world) {
      const y = p.y
      p.y = y * c - p.z * sn
      p.z = y * sn + p.z * c
    }
  }
  return { t, body, world, neutralNose: { x: 0, y: -0.6 }, scale: o.scale ?? 1, calibration: o.calibration ?? CAL }
}

const DT = 33

/** Runs a sequence of [left, right, opts?] poses at a fixed step and returns every punch. */
function run(
  seq: Array<[Arm, Arm, FrameOpts?]>,
  dt = DT,
  base: FrameOpts = {},
): Array<{ kind: string; hand: string }> {
  const d = createBoxingDetector()
  const out: Array<{ kind: string; hand: string }> = []
  seq.forEach(([l, r, o], i) => {
    for (const p of d.update(frame(1000 + i * dt, l, r, { ...base, ...o })).punches) out.push({ kind: p.kind, hand: p.hand })
  })
  return out
}

const hold = (l: Arm, r: Arm, n: number, o?: FrameOpts): Array<[Arm, Arm, FrameOpts?]> => Array.from({ length: n }, () => [l, r, o])
const move = (l0: Arm, l1: Arm, r0: Arm, r1: Arm, n: number, o?: FrameOpts): Array<[Arm, Arm, FrameOpts?]> =>
  Array.from({ length: n }, (_, i) => [lerpArm(l0, l1, (i + 1) / n), lerpArm(r0, r1, (i + 1) / n), o])

describe('boxing detector', () => {
  test('holding the guard throws nothing', () => {
    expect(run(hold(LEFT_GUARD, RIGHT_GUARD, 90))).toEqual([])
  })

  test('a straight right from the guard is a jab', () => {
    const seq = [...hold(LEFT_GUARD, RIGHT_GUARD, 40), ...move(LEFT_GUARD, LEFT_GUARD, RIGHT_GUARD, RIGHT_JAB, 5), ...hold(LEFT_GUARD, RIGHT_JAB, 5)]
    expect(run(seq)).toEqual([{ kind: 'jab', hand: 'right' }])
  })

  test('a short jab that never fully straightens still counts', () => {
    const seq = [
      ...hold(LEFT_GUARD, RIGHT_GUARD, 40),
      ...move(LEFT_GUARD, LEFT_GUARD, RIGHT_GUARD, RIGHT_SHORT_JAB, 4),
      ...hold(LEFT_GUARD, RIGHT_SHORT_JAB, 5),
    ]
    expect(run(seq).map((p) => p.hand)).toEqual(['right'])
  })

  test('raising both hands into the guard is not a punch', () => {
    const seq = [...hold(LEFT_DOWN, RIGHT_DOWN, 40), ...move(LEFT_DOWN, LEFT_GUARD, RIGHT_DOWN, RIGHT_GUARD, 10), ...hold(LEFT_GUARD, RIGHT_GUARD, 20)]
    expect(run(seq)).toEqual([])
  })

  test('two jabs in a row both count after the hand comes back', () => {
    const jab = [...move(LEFT_GUARD, LEFT_GUARD, RIGHT_GUARD, RIGHT_JAB, 5), ...hold(LEFT_GUARD, RIGHT_JAB, 3)]
    const back = [...move(LEFT_GUARD, LEFT_GUARD, RIGHT_JAB, RIGHT_GUARD, 6), ...hold(LEFT_GUARD, RIGHT_GUARD, 15)]
    const seq = [...hold(LEFT_GUARD, RIGHT_GUARD, 40), ...jab, ...back, ...jab]
    expect(run(seq).length).toBe(2)
  })
})

describe('calibration gate', () => {
  const pose = (t: number, opts: { wrists?: boolean; shoulderSpan?: number } = {}): PoseFrame => {
    const span = opts.shoulderSpan ?? 0.2
    const image = Array.from({ length: 33 }, () => j(0.5, 0.5))
    image[0] = j(0.5, 0.3)
    image[11] = j(0.5 - span / 2, 0.45)
    image[12] = j(0.5 + span / 2, 0.45)
    const wv = opts.wrists === false ? 0.1 : 0.95
    image[15] = j(0.4, 0.35, 0, wv)
    image[16] = j(0.6, 0.35, 0, wv)
    const world = Array.from({ length: 33 }, () => j(0, 0))
    world[11] = j(-0.18, -0.45)
    world[12] = j(0.18, -0.45)
    return { t, image, world }
  }

  test('asks for hands when the fists are out of view', () => {
    const c = createCalibrator()
    expect(c.push(pose(0, { wrists: false }), 4 / 3).status).toBe('hands-hidden')
  })

  test('asks the player to step back when too close', () => {
    const c = createCalibrator()
    expect(c.push(pose(0, { shoulderSpan: 0.6 }), 4 / 3).status).toBe('too-close')
  })

  test('locks in after about a second of a good stance', () => {
    const c = createCalibrator()
    let status = ''
    let t = 0
    for (; t <= 1400 && status !== 'done'; t += DT) status = c.push(pose(t), 4 / 3).status
    expect(status).toBe('done')
    expect(t).toBeLessThan(1400)
  })
})

// ---------- hardening rules ----------
const START = (): Array<[Arm, Arm, FrameOpts?]> => hold(LEFT_GUARD, RIGHT_GUARD, 40)
const jabR = (o?: FrameOpts): Array<[Arm, Arm, FrameOpts?]> => [
  ...move(LEFT_GUARD, LEFT_GUARD, RIGHT_GUARD, RIGHT_JAB, 5, o),
  ...hold(LEFT_GUARD, RIGHT_JAB, 3, o),
]
const LEFT_JAB: Arm = { wrist2d: [-0.2, -0.25], elbow2d: [-0.35, -0.15], elbowW: [-0.17, -0.45, -0.27], wristW: [-0.15, -0.45, -0.56] }
/** Right hook: elbow out and bent near 90 degrees, wrist sweeps from its own side across the midline. */
const RIGHT_HOOK_START: Arm = { wrist2d: [0.45, -0.4], elbow2d: [0.8, -0.2], elbowW: [0.42, -0.45, -0.05], wristW: [0.4, -0.45, -0.3] }
const RIGHT_HOOK_END: Arm = { wrist2d: [-0.15, -0.4], elbow2d: [0.5, -0.25], elbowW: [0.4, -0.45, -0.12], wristW: [0.18, -0.45, -0.36] }
/** Right uppercut: from chest height, fist drives up past the chin with a bent arm. */
const RIGHT_UC_START: Arm = { wrist2d: [0.25, 0.4], elbow2d: [0.5, 0.5], elbowW: [0.2, -0.2, -0.1], wristW: [0.12, -0.32, -0.26] }
const RIGHT_UC_END: Arm = { wrist2d: [0.2, -0.7], elbow2d: [0.45, -0.1], elbowW: [0.2, -0.32, -0.15], wristW: [0.12, -0.7, -0.26] }

describe('hardening: zero false positives', () => {
  test('a punch held out and pushed again without pulling back counts once (retraction hysteresis)', () => {
    const nudge = lerpArm(RIGHT_JAB, RIGHT_GUARD, 0.3)
    const seq = [
      ...START(),
      ...jabR(),
      ...hold(LEFT_GUARD, RIGHT_JAB, 12),
      ...move(LEFT_GUARD, LEFT_GUARD, RIGHT_JAB, nudge, 2),
      ...hold(LEFT_GUARD, nudge, 4),
      ...move(LEFT_GUARD, LEFT_GUARD, nudge, RIGHT_JAB, 2),
      ...hold(LEFT_GUARD, RIGHT_JAB, 6),
    ]
    expect(run(seq).length).toBe(1)
  })

  test('raising one hand from the waist to the guard is not an uppercut', () => {
    const seq = [...hold(LEFT_GUARD, RIGHT_DOWN, 40), ...move(LEFT_GUARD, LEFT_GUARD, RIGHT_DOWN, RIGHT_GUARD, 6), ...hold(LEFT_GUARD, RIGHT_GUARD, 15)]
    expect(run(seq)).toEqual([])
  })

  test('a real uppercut from chest height still counts', () => {
    const seq = [...hold(LEFT_GUARD, RIGHT_UC_START, 40), ...move(LEFT_GUARD, LEFT_GUARD, RIGHT_UC_START, RIGHT_UC_END, 4), ...hold(LEFT_GUARD, RIGHT_UC_END, 3)]
    expect(run(seq)).toEqual([{ kind: 'uppercut', hand: 'right' }])
  })

  test('a low-visibility arm freezes velocity: no punch while the wrist is a guess', () => {
    const seq = [...START(), ...jabR({ rightVis: 0.45 })]
    expect(run(seq)).toEqual([])
  })

  test('a single-frame shoulder-width jump (passer-by) suppresses the punch', () => {
    const jab = jabR()
    jab[1] = [jab[1][0], jab[1][1], { scale: 1.3 }]
    expect(run([...START(), ...jab])).toEqual([])
  })
})

describe('hardening: strike and defence disambiguation', () => {
  test('the same straight with the right shoulder driven forward is a cross', () => {
    const seq = [...START(), ...move(LEFT_GUARD, LEFT_GUARD, RIGHT_GUARD, RIGHT_JAB, 5, { rightShoulderZ: -0.06 }), ...hold(LEFT_GUARD, RIGHT_JAB, 3, { rightShoulderZ: -0.06 })]
    expect(run(seq)).toEqual([{ kind: 'cross', hand: 'right' }])
  })

  test('a lead-hand straight with a little rotation stays a jab, the rear hand with the same rotation is a cross', () => {
    const lead = [...START(), ...move(LEFT_GUARD, LEFT_JAB, RIGHT_GUARD, RIGHT_GUARD, 5, { rightShoulderZ: 0.025 }), ...hold(LEFT_JAB, RIGHT_GUARD, 3, { rightShoulderZ: 0.025 })]
    expect(run(lead)).toEqual([{ kind: 'jab', hand: 'left' }])
    const rear = [...START(), ...move(LEFT_GUARD, LEFT_GUARD, RIGHT_GUARD, RIGHT_JAB, 5, { rightShoulderZ: -0.025 }), ...hold(LEFT_GUARD, RIGHT_JAB, 3, { rightShoulderZ: -0.025 })]
    expect(run(rear)).toEqual([{ kind: 'cross', hand: 'right' }])
  })

  test('southpaw: the right hand leads, so a small-rotation right straight is a jab and the left is the cross', () => {
    const southpaw: Calibration = { ...CAL, stance: 'southpaw' }
    const right = [...START(), ...move(LEFT_GUARD, LEFT_GUARD, RIGHT_GUARD, RIGHT_JAB, 5, { rightShoulderZ: -0.025 }), ...hold(LEFT_GUARD, RIGHT_JAB, 3, { rightShoulderZ: -0.025 })]
    expect(run(right, DT, { calibration: southpaw })).toEqual([{ kind: 'jab', hand: 'right' }])
    const left = [...START(), ...move(LEFT_GUARD, LEFT_JAB, RIGHT_GUARD, RIGHT_GUARD, 5, { rightShoulderZ: 0.025 }), ...hold(LEFT_JAB, RIGHT_GUARD, 3, { rightShoulderZ: 0.025 })]
    expect(run(left, DT, { calibration: southpaw })).toEqual([{ kind: 'cross', hand: 'left' }])
  })

  test('a bent-arm lateral swing across the body is a hook', () => {
    const seq = [...hold(LEFT_GUARD, RIGHT_HOOK_START, 40), ...move(LEFT_GUARD, LEFT_GUARD, RIGHT_HOOK_START, RIGHT_HOOK_END, 4), ...hold(LEFT_GUARD, RIGHT_HOOK_END, 3)]
    expect(run(seq)).toEqual([{ kind: 'hook', hand: 'right' }])
  })

  test('slow nose drift while idle never reads as a duck, and a quick duck afterwards does', () => {
    const d = createBoxingDetector()
    let t = 1000
    let ducked = false
    // Player slumps 0.3 SW over 12 s while standing still.
    for (let i = 0; i < 360; i++, t += DT) {
      const a = d.update(frame(t, LEFT_GUARD, RIGHT_GUARD, { noseY: -0.6 + (0.3 * i) / 360 }))
      if (a.slip === 'duck') ducked = true
    }
    expect(ducked).toBe(false)
    let duck: string | null = null
    for (let i = 0; i < 6; i++, t += DT) duck = d.update(frame(t, LEFT_GUARD, RIGHT_GUARD, { noseY: -0.3 + 0.3 })).slip
    expect(duck).toBe('duck')
  })
})

describe('hardening: nose baseline is idle-only', () => {
  test('the neutral nose does not drift while the hands are busy, so a later duck is measured from true neutral', () => {
    const d = createBoxingDetector()
    let t = 1000
    for (let i = 0; i < 40; i++, t += DT) d.update(frame(t, LEFT_GUARD, RIGHT_GUARD))
    // 3 s of busy hands (left fist bobbing) while the head sinks 0.12 SW, below the duck threshold.
    for (let i = 0; i < 90; i++, t += DT) {
      const bob = { ...LEFT_GUARD, wrist2d: [-0.3 + 0.2 * Math.sin(i / 2), -0.5] as [number, number] }
      d.update(frame(t, bob, RIGHT_GUARD, { noseY: -0.6 + (0.12 * i) / 90 }))
    }
    let slip: string | null = null
    for (let i = 0; i < 4; i++, t += DT) slip = d.update(frame(t, LEFT_GUARD, RIGHT_GUARD, { noseY: -0.6 + 0.24 })).slip
    expect(slip).toBe('duck')
  })
})

describe('hardening: camera and venue resilience', () => {
  test('the same jab registers at 15, 30 and 60 fps', () => {
    for (const fps of [15, 30, 60]) {
      const dt = 1000 / fps
      const n = (ms: number): number => Math.max(1, Math.round(ms / dt))
      const seq = [
        ...hold(LEFT_GUARD, RIGHT_GUARD, n(1300)),
        ...move(LEFT_GUARD, LEFT_GUARD, RIGHT_GUARD, RIGHT_JAB, n(165)),
        ...hold(LEFT_GUARD, RIGHT_JAB, n(100)),
      ]
      expect(run(seq, dt).map((p) => p.hand), `${fps} fps`).toEqual(['right'])
    }
  })

  test('a webcam tilted up or down still reads the jab and never the guard', () => {
    for (const pitch of [-40, -25, 25, 40]) {
      const seq = [...hold(LEFT_GUARD, RIGHT_GUARD, 40, { pitch }), ...jabR({ pitch })]
      expect(run(seq), `pitch ${pitch}`).toEqual([{ kind: 'jab', hand: 'right' }])
      expect(run(hold(LEFT_GUARD, RIGHT_GUARD, 90, { pitch })), `guard pitch ${pitch}`).toEqual([])
      const raise = [...hold(LEFT_DOWN, RIGHT_DOWN, 40, { pitch }), ...move(LEFT_DOWN, LEFT_GUARD, RIGHT_DOWN, RIGHT_GUARD, 10, { pitch }), ...hold(LEFT_GUARD, RIGHT_GUARD, 20, { pitch })]
      expect(run(raise), `raise pitch ${pitch}`).toEqual([])
      const uc = [...hold(LEFT_GUARD, RIGHT_UC_START, 40, { pitch }), ...move(LEFT_GUARD, LEFT_GUARD, RIGHT_UC_START, RIGHT_UC_END, 4, { pitch }), ...hold(LEFT_GUARD, RIGHT_UC_END, 3, { pitch })]
      expect(run(uc), `uppercut pitch ${pitch}`).toEqual([{ kind: 'uppercut', hand: 'right' }])
    }
  })

  test('reach is measured in the torso plane, so camera pitch does not change it', () => {
    const reach = (pitch: number): { z: number; pitch: number } => {
      const d = createBoxingDetector()
      let dbg: Record<string, number> = {}
      for (let i = 0; i < 40; i++) dbg = d.update(frame(1000 + i * DT, LEFT_GUARD, RIGHT_JAB, { pitch })).debug
      return { z: dbg.rZReach, pitch: dbg.pitch }
    }
    const flat = reach(0)
    for (const p of [-30, 30]) {
      const tilted = reach(p)
      expect(tilted.z, `reach at pitch ${p}`).toBeCloseTo(flat.z, 2)
      expect(Math.abs(tilted.pitch), `learned pitch ${p}`).toBeCloseTo(30, 0)
    }
  })

  test('calibration reads a southpaw stance from the forward right side', () => {
    const c = createCalibrator()
    let cal: Calibration | null = null
    for (let t = 0; t < 2000 && !cal; t += DT) {
      const image = Array.from({ length: 33 }, () => j(0.5, 0.5))
      image[0] = j(0.5, 0.3)
      image[11] = j(0.4, 0.45)
      image[12] = j(0.6, 0.45)
      image[15] = j(0.42, 0.35)
      image[16] = j(0.58, 0.35)
      const world = Array.from({ length: 33 }, () => j(0, 0))
      world[11] = j(-0.18, -0.45, 0.04)
      world[12] = j(0.18, -0.45, -0.04)
      world[15] = j(-0.1, -0.5, -0.15)
      world[16] = j(0.1, -0.5, -0.3)
      cal = c.push({ t, image, world }, 4 / 3).calibration
    }
    expect(cal?.stance).toBe('southpaw')
  })
})

describe('one euro filter', () => {
  test('a timestamp hitch does not let one sample jump straight through', async () => {
    const { OneEuroFilter } = await import('../../src/pose/oneEuro.ts')
    const f = new OneEuroFilter({ minCutoff: 1.2, beta: 0, dCutoff: 1 })
    f.filter(0, 0)
    // 400 ms hitch then a noisy 10 px spike: the clamped step keeps it well below the raw value.
    expect(f.filter(10, 400)).toBeLessThan(5)
  })
})
