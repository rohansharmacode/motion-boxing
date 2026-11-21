// Turns a pose frame into a screen point for the hand cursor. Pure, unit tested.
import type { Joint } from '../pose/types.ts'

export type PointerHand = 'left' | 'right'

const L_SHOULDER = 11
const R_SHOULDER = 12
const L_WRIST = 15
const R_WRIST = 16
const L_INDEX = 19
const R_INDEX = 20

const MIN_VIS = 0.5

export interface PointerConfig {
  /** Control box width in shoulder widths. Smaller means less arm travel for the full screen. */
  boxWidthSW: number
  /** Control box centre, shoulder widths above (-) or below (+) shoulder height. */
  boxCenterYSW: number
  /** Control box centre, shoulder widths out from the body centre toward the pointing hand. */
  boxCenterXSW: number
  /** A hand counts as raised when the wrist is above shoulder height + this many shoulder widths. */
  raiseLineSW: number
}

export const DEFAULT_POINTER: PointerConfig = { boxWidthSW: 2.4, boxCenterYSW: 0.1, boxCenterXSW: 0.7, raiseLineSW: 1.1 }

export interface PointerSample {
  hand: PointerHand
  /** 0 to 1 of the screen. */
  x: number
  y: number
}

const ok = (j: Joint | undefined): j is Joint => j !== undefined && j.visibility >= MIN_VIS

/**
 * Picks the pointing hand and maps it into a comfortable box beside the shoulder.
 * image: mirrored image landmarks (0 to 1). aspect: video width / height. screenAspect: viewport width / height.
 * prev keeps the same hand while it stays raised, so the cursor does not jump between hands.
 */
export function pointerFromPose(
  image: readonly Joint[],
  aspect: number,
  screenAspect: number,
  prev: PointerHand | null,
  cfg: PointerConfig = DEFAULT_POINTER,
): PointerSample | null {
  const ls = image[L_SHOULDER]
  const rs = image[R_SHOULDER]
  if (!ok(ls) || !ok(rs)) return null
  // Work in height units so x and y distances match.
  const sw = Math.hypot((ls.x - rs.x) * aspect, ls.y - rs.y)
  if (sw < 0.02) return null
  const midX = ((ls.x + rs.x) / 2) * aspect
  const midY = (ls.y + rs.y) / 2

  const candidate = (hand: PointerHand): { hand: PointerHand; x: number; y: number; wristY: number } | null => {
    const wrist = image[hand === 'left' ? L_WRIST : R_WRIST]
    if (!ok(wrist)) return null
    if (wrist.y > midY + cfg.raiseLineSW * sw) return null
    const index = image[hand === 'left' ? L_INDEX : R_INDEX]
    // Lean toward the fingertip when it is tracked: pointing feels natural, the wrist alone is steadier.
    const px = ok(index) ? wrist.x * 0.4 + index.x * 0.6 : wrist.x
    const py = ok(index) ? wrist.y * 0.4 + index.y * 0.6 : wrist.y
    return { hand, x: px * aspect, y: py, wristY: wrist.y }
  }

  const left = candidate('left')
  const right = candidate('right')
  let pick = prev === 'left' && left ? left : prev === 'right' && right ? right : null
  if (!pick) pick = left && right ? (left.wristY <= right.wristY ? left : right) : (left ?? right)
  if (!pick) return null

  // Image x is mirrored for a selfie view, so the player's left hand sits at the smaller x.
  const side = pick.hand === 'left' ? -1 : 1
  const w = cfg.boxWidthSW * sw
  const h = w / Math.max(screenAspect, 0.1)
  const cx = midX + side * cfg.boxCenterXSW * sw
  const cy = midY + cfg.boxCenterYSW * sw
  return {
    hand: pick.hand,
    x: clamp01((pick.x - (cx - w / 2)) / w),
    y: clamp01((pick.y - (cy - h / 2)) / h),
  }
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Dead-zone: small moves are ignored, bigger moves follow minus the radius. Units are whatever you feed (px). */
export class DeadZone {
  private x: number | null = null
  private y = 0
  private readonly radius: number

  constructor(radius: number) {
    this.radius = radius
  }

  apply(x: number, y: number): { x: number; y: number } {
    if (this.x === null) {
      this.x = x
      this.y = y
      return { x, y }
    }
    const dx = x - this.x
    const dy = y - this.y
    const d = Math.hypot(dx, dy)
    if (d > this.radius) {
      const k = (d - this.radius) / d
      this.x += dx * k
      this.y += dy * k
    }
    return { x: this.x, y: this.y }
  }

  reset(): void {
    this.x = null
  }
}

export interface RectLike {
  left: number
  top: number
  right: number
  bottom: number
}

/** Distance from a point to a rectangle (0 inside). */
export function rectDistance(r: RectLike, x: number, y: number): number {
  const dx = Math.max(r.left - x, 0, x - r.right)
  const dy = Math.max(r.top - y, 0, y - r.bottom)
  return Math.hypot(dx, dy)
}
