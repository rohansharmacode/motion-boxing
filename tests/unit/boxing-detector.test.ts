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

function frame(t: number, left: Arm, right: Arm): BodyFrame {
  const body = Array.from({ length: 33 }, () => j(0, 0, 0, 0))
  const world = Array.from({ length: 33 }, () => j(0, 0, 0, 0))
  body[0] = j(0, -0.6)
  world[0] = j(0, -0.6, -0.1)
  body[11] = j(-0.5, 0)
  body[12] = j(0.5, 0)
  world[11] = j(-0.18, -0.45, 0)
  world[12] = j(0.18, -0.45, 0)
  const put = (arm: Arm, e: number, w: number): void => {
    body[e] = j(...arm.elbow2d)
    body[w] = j(...arm.wrist2d)
    world[e] = j(...arm.elbowW)
    world[w] = j(...arm.wristW)
  }
  put(left, 13, 15)
  put(right, 14, 16)
  return { t, body, world, neutralNose: { x: 0, y: -0.6 }, scale: 1, calibration: CAL }
}

const DT = 33

/** Runs a sequence of [left, right] poses at 30 fps and returns every punch. */
function run(seq: Array<[Arm, Arm]>): Array<{ kind: string; hand: string }> {
  const d = createBoxingDetector()
  const out: Array<{ kind: string; hand: string }> = []
  seq.forEach(([l, r], i) => {
    for (const p of d.update(frame(1000 + i * DT, l, r)).punches) out.push({ kind: p.kind, hand: p.hand })
  })
  return out
}

const hold = (l: Arm, r: Arm, n: number): Array<[Arm, Arm]> => Array.from({ length: n }, () => [l, r])
const move = (l0: Arm, l1: Arm, r0: Arm, r1: Arm, n: number): Array<[Arm, Arm]> =>
  Array.from({ length: n }, (_, i) => [lerpArm(l0, l1, (i + 1) / n), lerpArm(r0, r1, (i + 1) / n)])

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
