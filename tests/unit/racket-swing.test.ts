// Racket swing detector (src/sports/racket/swing.ts): moved out of racket/index.ts so the motion lab can tune it.
import { describe, expect, test } from 'vitest'
import { DEFAULT_SWING_CONFIG, createSwingDetector } from '../../src/sports/racket/swing.ts'
import type { BodyFrame, Calibration, Joint } from '../../src/pose/types.ts'
import { GAMES } from '../../src/dev/recordingFormat.ts'
import { autoTune, defaultsFor, replayOptionsFor, tunablesFor } from '../../tools/replay/score.ts'

const CAL: Calibration = { aspect: 4 / 3, shoulderWidth: 0.25, shoulderWidthWorld: 0.36, torsoCenter: { x: 0.5, y: 0.45 }, neutralNose: { x: 0.5, y: 0.3 } }

/** Body-space wrists (shoulder widths, x right, y down). */
function frame(t: number, left: [number, number], right: [number, number], vis = 0.99): BodyFrame {
  const body: Joint[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }))
  body[15] = { x: left[0], y: left[1], z: 0, visibility: vis }
  body[16] = { x: right[0], y: right[1], z: 0, visibility: vis }
  return { t, body, world: body.map((j) => ({ ...j })), neutralNose: { x: 0, y: -0.6 }, scale: 1, calibration: CAL }
}

/** 30 fps; the right wrist moves dx shoulder widths per frame. */
/** Frame times start at 10 s (performance.now in a real session; the cooldown starts from t = 0). */
function run(dxPerFrame: number[], start = 10_000) {
  const d = createSwingDetector()
  let x = -0.5
  return dxPerFrame.map((dx, i) => {
    x += dx
    return d.push(frame(start + i * 33.3, [-0.6, 0.2], [x, 0]))
  })
}

describe('createSwingDetector', () => {
  test('slow hand movement moves the paddle but never swings', () => {
    const out = run(Array(30).fill(0.05)) // 1.5 SW/s
    expect(out.every((s) => s.swing === null)).toBe(true)
    expect(out.at(-1)!.handX).toBeCloseTo(-0.5 + 30 * 0.05, 5)
  })

  test('a fast sideways flick swings once, with power and aim to that side', () => {
    const out = run([0, 0, 0.25, 0.25, 0.25, 0, 0]) // 7.5 SW/s
    const swings = out.filter((s) => s.swing)
    expect(swings).toHaveLength(1)
    const sw = swings[0].swing!
    expect(sw.hand).toBe('right')
    expect(sw.speed).toBeCloseTo(7.5, 1)
    expect(sw.power).toBeCloseTo((7.5 - DEFAULT_SWING_CONFIG.powerFloor) / DEFAULT_SWING_CONFIG.powerRange, 2)
    expect(sw.aim).toBeCloseTo(1, 5)
  })

  test('cooldown: a second fast swing within 350 ms does not fire, after it does', () => {
    const near = run([0, 0.25, 0, 0, -0.25, 0]) // second flick about 100 ms later
    expect(near.filter((s) => s.swing)).toHaveLength(1)
    const far = run([0, 0.25, ...Array(12).fill(0), -0.25])
    expect(far.filter((s) => s.swing)).toHaveLength(2)
  })

  test('the hitting hand follows the fastest wrist; low visibility is ignored', () => {
    const d = createSwingDetector()
    d.push(frame(10_000, [-0.6, 0], [0.5, 0]))
    const s = d.push(frame(10_033, [-0.3, 0], [0.5, 0])) // left wrist moves 9 SW/s
    expect(s.hand).toBe('left')
    expect(s.swing?.hand).toBe('left')
    const g = createSwingDetector()
    g.push(frame(10_000, [-0.6, 0], [0.5, 0], 0.2))
    expect(g.push(frame(10_033, [-0.3, 0], [0.5, 0], 0.2)).swing).toBeNull()
  })

  test('config overrides change the threshold', () => {
    const d = createSwingDetector({ swingMinSpeed: 9 })
    d.push(frame(10_000, [-0.6, 0], [0, 0]))
    expect(d.push(frame(10_033, [-0.6, 0], [0.25, 0])).swing).toBeNull() // 7.5 SW/s < 9
  })
})

describe('table tennis in the motion lab', () => {
  test('is a game with a detector and a swing tuner', async () => {
    expect(GAMES.tabletennis.labels).toEqual(['tt-swing', 'idle'])
    expect(GAMES.tabletennis.detector).toBe(true)
    expect(tunablesFor('swing').map((t) => t.key)).toContain('swingMinSpeed')
    expect(defaultsFor('swing').swingMinSpeed).toBe(4.5)
    expect(replayOptionsFor('swing', { swingMinSpeed: 5 })).toEqual({ swing: { swingMinSpeed: 5 } })
    const rec = {
      version: 1 as const, game: 'tabletennis' as const, person: 't', distanceM: 1.5, lighting: 'room', note: '', recordedAt: '2026-11-21T10:00:00.000Z',
      aspect: 4 / 3, inferenceMs: 10, frames: [null, null], segments: [{ label: 'tt-swing' as const, startT: 0, endT: 100, reps: 3, marks: [] }],
    }
    const res = await autoTune('swing', [rec], GAMES.tabletennis.labels, {}, 1)
    expect(res.config).toEqual({})
  })
})
