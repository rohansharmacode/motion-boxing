import { describe, expect, test } from 'vitest'
import { createPosePredictor } from '../../src/pose/predict.ts'
import { defaultCalibration } from '../../src/pose/calibration.ts'
import type { BodyFrame, Joint } from '../../src/pose/types.ts'

const j = (x: number, y = 0, z = 0): Joint => ({ x, y, z, visibility: 1 })
const CAL = defaultCalibration(4 / 3)

function frame(t: number, wristX: number): BodyFrame {
  const body = Array.from({ length: 33 }, () => j(0))
  const world = Array.from({ length: 33 }, () => j(0))
  body[16] = j(wristX)
  world[16] = j(wristX * 0.36)
  return { t, body, world, neutralNose: { x: 0, y: -0.6 }, scale: 1, calibration: CAL }
}

describe('pose predictor', () => {
  test('draws a moving wrist about 40 ms ahead', () => {
    const p = createPosePredictor()
    let out: BodyFrame | null = null
    // 3 SW/s to the right at 30 fps.
    for (let i = 0; i < 6; i++) out = p.push(frame(i * 33, i * 0.1))
    const x = out!.body[16].x
    expect(x).toBeGreaterThan(0.5 + 0.1)
    expect(x).toBeCloseTo(0.5 + 3.03 * 0.04, 1)
  })

  test('does not overshoot when the hand stops dead', () => {
    const p = createPosePredictor()
    for (let i = 0; i < 6; i++) p.push(frame(i * 33, i * 0.1))
    const out = p.push(frame(6 * 33, 0.5))
    expect(out!.body[16].x).toBeCloseTo(0.5, 6)
  })

  test('caps the lead on a huge jump', () => {
    const p = createPosePredictor()
    p.push(frame(0, 0))
    p.push(frame(33, 1))
    const out = p.push(frame(66, 2))
    expect(out!.body[16].x - 2).toBeLessThanOrEqual(0.3 + 1e-9)
  })

  test('leaves the input frame untouched and passes still joints through', () => {
    const p = createPosePredictor()
    const f = frame(0, 0.2)
    p.push(f)
    const g = frame(33, 0.2)
    const out = p.push(g)
    expect(g.body[16].x).toBe(0.2)
    expect(out!.body[16].x).toBeCloseTo(0.2, 9)
    expect(out!.body[0]).toBe(g.body[0])
  })
})
