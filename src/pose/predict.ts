// Latency hiding for drawn hands: camera, tracking and filtering put pose data 50 to 90 ms behind the real
// movement, so the gloves are drawn where the arms will be leadMs from now (position + velocity * lead).
// Only for drawing: game logic and the punch detector keep the measured pose.
// Overshoot guards: the lead is capped per joint, and the smaller of the instant and smoothed velocity is
// used, so a punch that stops dead does not fly past its end point.
import { LM } from './types.ts'
import type { BodyFrame, Joint } from './types.ts'

export interface PredictorConfig {
  /** How far ahead to draw, ms. */
  leadMs: number
  /** Largest body-space shift, shoulder widths. */
  maxBodyLead: number
  /** Largest world shift, metres. */
  maxWorldLead: number
  /** Weight of the newest velocity in the smoothed velocity. */
  smoothing: number
  /** Frames further apart than this are not differentiated, ms. */
  maxGapMs: number
}

export const DEFAULT_PREDICTOR: PredictorConfig = {
  leadMs: 40,
  maxBodyLead: 0.3,
  maxWorldLead: 0.1,
  smoothing: 0.5,
  maxGapMs: 150,
}

/** Arms only: they carry the fast motion and the drawn gloves. */
const PREDICTED = [LM.L_ELBOW, LM.R_ELBOW, LM.L_WRIST, LM.R_WRIST] as const

export interface PosePredictor {
  /** Returns a frame with arm joints moved leadMs ahead. The input frame is not modified. */
  push(frame: BodyFrame | null): BodyFrame | null
  reset(): void
}

type Vec = [number, number, number]

interface JointState {
  prevBody: Vec
  prevWorld: Vec
  vBody: Vec
  vWorld: Vec
}

const smaller = (a: number, b: number): number => (Math.sign(a) !== Math.sign(b) ? 0 : Math.abs(a) < Math.abs(b) ? a : b)

function capped(v: Vec, leadS: number, max: number): Vec {
  const d: Vec = [v[0] * leadS, v[1] * leadS, v[2] * leadS]
  const n = Math.hypot(d[0], d[1], d[2])
  if (n > max && n > 0) {
    const k = max / n
    d[0] *= k
    d[1] *= k
    d[2] *= k
  }
  return d
}

export function createPosePredictor(config: Partial<PredictorConfig> = {}): PosePredictor {
  const cfg = { ...DEFAULT_PREDICTOR, ...config }
  const state = new Map<number, JointState>()
  let lastT: number | null = null

  return {
    push(frame) {
      if (!frame) {
        state.clear()
        lastT = null
        return null
      }
      const dtS = lastT === null ? 0 : (frame.t - lastT) / 1000
      const fresh = !(dtS > 0) || dtS * 1000 > cfg.maxGapMs
      lastT = frame.t
      const body = frame.body.slice()
      const world = frame.world.slice()
      const leadS = cfg.leadMs / 1000
      for (const i of PREDICTED) {
        const b = frame.body[i]
        const w = frame.world[i]
        if (!b || !w) continue
        const pb: Vec = [b.x, b.y, 0]
        const pw: Vec = [w.x, w.y, w.z]
        const s = state.get(i)
        if (!s || fresh) {
          state.set(i, { prevBody: pb, prevWorld: pw, vBody: [0, 0, 0], vWorld: [0, 0, 0] })
          continue
        }
        const k = cfg.smoothing
        const instB: Vec = [(pb[0] - s.prevBody[0]) / dtS, (pb[1] - s.prevBody[1]) / dtS, 0]
        const instW: Vec = [(pw[0] - s.prevWorld[0]) / dtS, (pw[1] - s.prevWorld[1]) / dtS, (pw[2] - s.prevWorld[2]) / dtS]
        for (let a = 0; a < 3; a++) {
          s.vBody[a] += k * (instB[a] - s.vBody[a])
          s.vWorld[a] += k * (instW[a] - s.vWorld[a])
        }
        s.prevBody = pb
        s.prevWorld = pw
        const useB: Vec = [smaller(instB[0], s.vBody[0]), smaller(instB[1], s.vBody[1]), 0]
        const useW: Vec = [smaller(instW[0], s.vWorld[0]), smaller(instW[1], s.vWorld[1]), smaller(instW[2], s.vWorld[2])]
        const db = capped(useB, leadS, cfg.maxBodyLead)
        const dw = capped(useW, leadS, cfg.maxWorldLead)
        body[i] = { ...b, x: b.x + db[0], y: b.y + db[1] } satisfies Joint
        world[i] = { ...w, x: w.x + dw[0], y: w.y + dw[1], z: w.z + dw[2] } satisfies Joint
      }
      return { ...frame, body, world }
    },
    reset() {
      state.clear()
      lastT = null
    },
  }
}
