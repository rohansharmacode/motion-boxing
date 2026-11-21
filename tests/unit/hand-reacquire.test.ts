// A hand that leaves the frame (any edge) reads as invisible, and snaps straight back when it returns.
import { describe, expect, test } from 'vitest'
import { createBodyTracker } from '../../src/pose/body.ts'
import { LM } from '../../src/pose/types.ts'
import type { Calibration, Joint, PoseFrame } from '../../src/pose/types.ts'

const cal: Calibration = {
  aspect: 1,
  shoulderWidth: 0.25,
  shoulderWidthWorld: 0.36,
  torsoCenter: { x: 0.5, y: 0.45 },
  neutralNose: { x: 0.5, y: 0.3 },
} as Calibration

function frame(t: number, wrist: { x: number; y: number; v: number }): PoseFrame {
  const image: Joint[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }))
  image[LM.L_SHOULDER] = { x: 0.375, y: 0.45, z: 0, visibility: 0.9 }
  image[LM.R_SHOULDER] = { x: 0.625, y: 0.45, z: 0, visibility: 0.9 }
  image[LM.R_WRIST] = { x: wrist.x, y: wrist.y, z: 0, visibility: wrist.v }
  const world = image.map((j) => ({ ...j }))
  return { t, image, world }
}

const edges = [
  { name: 'left', out: { x: -0.1, y: 0.5 } },
  { name: 'right', out: { x: 1.1, y: 0.5 } },
  { name: 'top', out: { x: 0.6, y: -0.1 } },
  { name: 'bottom', out: { x: 0.6, y: 1.1 } },
]

describe('hand leaves and re-enters the frame', () => {
  for (const e of edges) {
    test(`via the ${e.name} edge`, () => {
      const tr = createBodyTracker(cal, { minCutoff: 1.6, beta: 0.08, dCutoff: 1 })
      let t = 0
      for (let i = 0; i < 20; i++) tr.push(frame((t += 33), { x: 0.7, y: 0.6, v: 0.95 }))
      // Out of frame for 400 ms: the model still guesses a position with fair visibility.
      for (let i = 0; i < 12; i++) {
        const f = tr.push(frame((t += 33), { ...e.out, v: 0.6 }))!
        expect(f.body[LM.R_WRIST].visibility).toBe(0)
      }
      // Back in at a new spot: visible on the first frame and right where the hand is (no easing lag).
      const back = tr.push(frame((t += 33), { x: 0.3, y: 0.7, v: 0.9 }))!
      const w = back.body[LM.R_WRIST]
      expect(w.visibility).toBeGreaterThan(0.5)
      expect(w.x).toBeCloseTo((0.3 - 0.5) / 0.25, 3)
      expect(w.y).toBeCloseTo((0.7 - 0.45) / 0.25, 3)
    })
  }
})
