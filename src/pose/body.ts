// Turns raw PoseFrames into calibrated, 1-euro filtered BodyFrames for game logic.
import { OneEuroFilter } from './oneEuro.ts'
import type { OneEuroParams } from './oneEuro.ts'
import { LM, TRACKED_JOINTS } from './types.ts'
import type { BodyFrame, Calibration, Joint, PoseFrame } from './types.ts'

export interface BodyTracker {
  /** Feed every frame in time order. Returns null for a null frame. */
  push(frame: PoseFrame | null): BodyFrame | null
  reset(): void
}

// The doc's filter params (beta 0.08 per unit/s) assume units where a fast punch moves hundreds of
// units per second. In 0 to 1 image units or metres beta would barely raise the cutoff and punches
// would lag, so image coordinates are filtered in pixels of a virtual frame this tall and world
// coordinates in millimetres.
const FILTER_HEIGHT_PX = 480
const MM_PER_M = 1000
/** A longer gap between frames restarts the filters instead of easing across it, ms. */
const RESET_GAP_MS = 250
/** Live shoulder width only updates scale when both shoulders are this visible. */
const MIN_VISIBILITY = 0.5
/** A joint below this visibility (or outside the image) counts as lost. */
const LOST_VISIBILITY = 0.3
/** A joint lost this long restarts its filters, so it snaps back when it re-enters instead of easing in. */
const LOST_RESET_MS = 200
/** Image margin: a landmark guessed this far past the edge is out of frame. */
const EDGE_MARGIN = 0.02
const inFrame = (x: number, y: number): boolean =>
  x >= -EDGE_MARGIN && x <= 1 + EDGE_MARGIN && y >= -EDGE_MARGIN && y <= 1 + EDGE_MARGIN

interface JointFilters {
  index: number
  imageX: OneEuroFilter
  imageY: OneEuroFilter
  worldX: OneEuroFilter
  worldY: OneEuroFilter
  worldZ: OneEuroFilter
  /** When the joint was last seen going out of frame or invisible, ms; null while visible. */
  lostAt: number | null
}

export function createBodyTracker(calibration: Calibration, params: OneEuroParams): BodyTracker {
  const { aspect, shoulderWidth: s, torsoCenter: c } = calibration
  const neutralNose = { x: (calibration.neutralNose.x - c.x) / s, y: (calibration.neutralNose.y - c.y) / s }
  const filters: JointFilters[] = TRACKED_JOINTS.map((index) => ({
    index,
    imageX: new OneEuroFilter(params),
    imageY: new OneEuroFilter(params),
    worldX: new OneEuroFilter(params),
    worldY: new OneEuroFilter(params),
    worldZ: new OneEuroFilter(params),
    lostAt: null,
  }))
  let lastT: number | null = null
  let scale = 1

  /** (xa, y) are aspect-corrected image units (x already multiplied by aspect). */
  const toBody = (xa: number, y: number, visibility: number): Joint => ({
    x: (xa - c.x) / s,
    y: (y - c.y) / s,
    z: 0,
    visibility,
  })

  const resetFilters = (): void => {
    for (const f of filters) {
      f.imageX.reset()
      f.imageY.reset()
      f.worldX.reset()
      f.worldY.reset()
      f.worldZ.reset()
      f.lostAt = null
    }
  }

  return {
    push(frame) {
      if (!frame || frame.image.length < 33 || frame.world.length < 33) return null
      const t = frame.t
      if (lastT !== null && t - lastT > RESET_GAP_MS) resetFilters()
      lastT = t

      const body = frame.image.map((p) => toBody(p.x * aspect, p.y, p.visibility))
      const world = frame.world.map((p): Joint => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility }))
      for (const f of filters) {
        const p = frame.image[f.index]
        // Out of frame or barely visible: the model is guessing. Report it as invisible, and once it has
        // been gone a moment, restart its filters so it is picked up instantly when it comes back.
        const seen = inFrame(p.x, p.y) && (p.visibility ?? 0) >= LOST_VISIBILITY
        if (!seen) {
          f.lostAt ??= t
          body[f.index] = toBody(p.x * aspect, p.y, 0)
          world[f.index] = { ...world[f.index], visibility: 0 }
          continue
        }
        if (f.lostAt !== null && t - f.lostAt > LOST_RESET_MS) {
          f.imageX.reset()
          f.imageY.reset()
          f.worldX.reset()
          f.worldY.reset()
          f.worldZ.reset()
        }
        f.lostAt = null
        const xa = f.imageX.filter(p.x * aspect * FILTER_HEIGHT_PX, t) / FILTER_HEIGHT_PX
        const y = f.imageY.filter(p.y * FILTER_HEIGHT_PX, t) / FILTER_HEIGHT_PX
        body[f.index] = toBody(xa, y, p.visibility)
        const w = frame.world[f.index]
        world[f.index] = {
          x: f.worldX.filter(w.x * MM_PER_M, t) / MM_PER_M,
          y: f.worldY.filter(w.y * MM_PER_M, t) / MM_PER_M,
          z: f.worldZ.filter(w.z * MM_PER_M, t) / MM_PER_M,
          visibility: w.visibility,
        }
      }

      // Body space is already in calibrated shoulder widths, so the live width here is the scale.
      const l = body[LM.L_SHOULDER]
      const r = body[LM.R_SHOULDER]
      const live = Math.hypot(l.x - r.x, l.y - r.y)
      if (l.visibility > MIN_VISIBILITY && r.visibility > MIN_VISIBILITY && live > 0.05 && Number.isFinite(live)) {
        scale = live
      }

      return { t, body, world, neutralNose, scale, calibration }
    },

    reset() {
      resetFilters()
      lastT = null
      scale = 1
    },
  }
}
