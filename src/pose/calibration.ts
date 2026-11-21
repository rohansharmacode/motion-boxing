// 2 s hold-stance gate (research doc, Shared Camera Calibration).
// Averages shoulder width S, torso centre C and neutral nose N0 over frames with both shoulders visible.
import { LM } from './types.ts'
import type { Calibration, CalibrationStatus, PoseFrame } from './types.ts'

export interface CalibrationProgress {
  status: CalibrationStatus
  /** 0 to 1. Reaches 1 only when status is done. */
  progress: number
  /** Set once status is done. */
  calibration: Calibration | null
}

export interface Calibrator {
  /** Feed every frame in time order (null when no pose). aspect = video width / height. */
  push(frame: PoseFrame | null, aspect: number): CalibrationProgress
  reset(): void
}

/** Shoulder visibility needed for a frame to count. */
const MIN_VISIBILITY = 0.5
/** A longer gap between valid frames restarts the hold, ms. */
const MAX_GAP_MS = 500
/** Smallest believable 2D shoulder width (aspect-corrected image units). Narrower means side-on or a bad fit. */
const MIN_SHOULDER_2D = 0.03
/** Floor for the world shoulder width, metres. */
const MIN_SHOULDER_WORLD = 0.1

const safeAspect = (aspect: number): number => (Number.isFinite(aspect) && aspect > 0 ? aspect : 4 / 3)

/** Plausible calibration for a player centred about 1.2 m from the camera (keyboard-only play). */
export function defaultCalibration(aspect: number): Calibration {
  const a = safeAspect(aspect)
  return {
    aspect: a,
    shoulderWidth: 0.28,
    shoulderWidthWorld: 0.36,
    torsoCenter: { x: a / 2, y: 0.55 },
    neutralNose: { x: a / 2, y: 0.38 },
  }
}

export function createCalibrator(options?: { holdMs?: number; minFrames?: number }): Calibrator {
  const holdMs = options?.holdMs ?? 2000
  const minFrames = options?.minFrames ?? 15

  let sum = { s: 0, sw: 0, cx: 0, cy: 0, nx: 0, ny: 0 }
  let count = 0
  let validMs = 0
  /** t of the last valid frame, null before the first one. */
  let lastValidT: number | null = null
  /** The previous pushed frame was valid, so the time since it counts toward the hold. */
  let prevValid = false
  let result: Calibration | null = null

  const clear = (): void => {
    sum = { s: 0, sw: 0, cx: 0, cy: 0, nx: 0, ny: 0 }
    count = 0
    validMs = 0
    lastValidT = null
    prevValid = false
  }

  const progress = (): number => Math.min(1, validMs / holdMs, count / minFrames)

  const report = (status: CalibrationStatus): CalibrationProgress => ({ status, progress: progress(), calibration: null })

  return {
    push(frame, aspect) {
      if (result) return { status: 'done', progress: 1, calibration: result }
      if (!frame) {
        prevValid = false
        return report('no-pose')
      }

      if (lastValidT !== null && frame.t - lastValidT > MAX_GAP_MS) clear()
      if (frame.image.length < 33 || frame.world.length < 33) {
        prevValid = false
        return report('no-pose')
      }

      const a = safeAspect(aspect)
      const l = frame.image[LM.L_SHOULDER]
      const r = frame.image[LM.R_SHOULDER]
      const nose = frame.image[LM.NOSE]
      const lw = frame.world[LM.L_SHOULDER]
      const rw = frame.world[LM.R_SHOULDER]
      const s = Math.hypot((l.x - r.x) * a, l.y - r.y)
      if (l.visibility <= MIN_VISIBILITY || r.visibility <= MIN_VISIBILITY || !(s >= MIN_SHOULDER_2D)) {
        prevValid = false
        return report('shoulders-hidden')
      }

      if (prevValid && lastValidT !== null) validMs += frame.t - lastValidT
      lastValidT = frame.t
      prevValid = true
      count++
      sum.s += s
      sum.sw += Math.hypot(lw.x - rw.x, lw.y - rw.y, lw.z - rw.z)
      sum.cx += ((l.x + r.x) / 2) * a
      sum.cy += (l.y + r.y) / 2
      sum.nx += nose.x * a
      sum.ny += nose.y

      if (validMs < holdMs || count < minFrames) return report('holding')
      result = {
        aspect: a,
        shoulderWidth: Math.max(MIN_SHOULDER_2D, sum.s / count),
        shoulderWidthWorld: Math.max(MIN_SHOULDER_WORLD, sum.sw / count),
        torsoCenter: { x: sum.cx / count, y: sum.cy / count },
        neutralNose: { x: sum.nx / count, y: sum.ny / count },
      }
      return { status: 'done', progress: 1, calibration: result }
    },

    reset() {
      clear()
      result = null
    },
  }
}
