// Body space -> goal plane mapping (research doc section 3, "Calibration Mapping").
// Body space: origin torso centre C, unit shoulder width S, x screen right, y DOWN.
// World: metres on the goal plane, y up.

import type { BodyFrame, KeeperPose, Vec3 } from './types.ts'
import type { Joint } from '../../pose/types.ts'
import { GOAL_HALF_WIDTH, GOAL_HEIGHT } from './physics.ts'

/** Gloves and torso live on the goal plane. */
export const KEEPER_Z = 0

// Reach box in body space. Kept a little inside a full arm span so a comfortable reach (not a full lunge)
// covers the corners; players at a laptop rarely have room to dive.
const REACH_X_MIN = -1.25
const REACH_X_MAX = 1.25
const REACH_Y_TOP = -1.0 // body y at the top of the goal
const REACH_Y_BOTTOM = 0.5 // body y at the lowest reach
const WORLD_Y_TOP = GOAL_HEIGHT
const WORLD_Y_BOTTOM = 0.2
const OVERREACH = 1.12
const MIN_WORLD_Y = 0.05

/** Mild power curve that expands reach near the edges: sign(u) * |u|^0.85. */
export function edgeCurve(u: number): number {
  return Math.sign(u) * Math.pow(Math.abs(u), 0.85)
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Map a body-space point to goal-plane world coordinates (x right, y up, metres). */
export function bodyToGoal(bx: number, by: number): { x: number; y: number } {
  const ux = clamp(((bx - REACH_X_MIN) / (REACH_X_MAX - REACH_X_MIN)) * 2 - 1, -OVERREACH, OVERREACH)
  // uy = +1 at the top of the reach box (body y -1.1), -1 at the bottom (body y 0.5).
  const uy = clamp(((REACH_Y_BOTTOM - by) / (REACH_Y_BOTTOM - REACH_Y_TOP)) * 2 - 1, -OVERREACH, OVERREACH)
  const cx = edgeCurve(ux)
  const cy = edgeCurve(uy)
  const x = cx * GOAL_HALF_WIDTH
  const mid = (WORLD_Y_TOP + WORLD_Y_BOTTOM) / 2
  const half = (WORLD_Y_TOP - WORLD_Y_BOTTOM) / 2
  const y = Math.max(MIN_WORLD_Y, mid + cy * half)
  return { x, y }
}

const NOSE = 0
const L_SHOULDER = 11
const R_SHOULDER = 12
const L_WRIST = 15
const R_WRIST = 16
const L_INDEX = 19
const R_INDEX = 20

function vis(j: Joint | undefined): number {
  return j ? j.visibility : 0
}

function mapJoint(j: Joint): Vec3 {
  const g = bodyToGoal(j.x, j.y)
  return { x: g.x, y: g.y, z: KEEPER_Z }
}

function glovePos(body: Joint[], tip: number, wrist: number, shoulder: number): Vec3 {
  const t = body[tip]
  const w = body[wrist]
  if (t && vis(t) >= 0.5) return mapJoint(t)
  if (w && vis(w) >= 0.3) return mapJoint(w)
  if (t && vis(t) >= 0.3) return mapJoint(t)
  return mapJoint(body[shoulder] as Joint)
}

/** Keeper pose from a calibrated body frame. null only when both shoulders are hidden. */
export function keeperPoseFromBody(body: BodyFrame): KeeperPose | null {
  const j = body.body
  const ls = j[L_SHOULDER]
  const rs = j[R_SHOULDER]
  if (!ls || !rs || (vis(ls) < 0.3 && vis(rs) < 0.3)) return null
  // If only one shoulder is visible, use it for both shoulder-derived positions.
  const lsUse = vis(ls) >= 0.3 ? ls : rs
  const rsUse = vis(rs) >= 0.3 ? rs : ls

  const left = glovePos(j, L_INDEX, L_WRIST, lsUse === ls ? L_SHOULDER : R_SHOULDER)
  const right = glovePos(j, R_INDEX, R_WRIST, rsUse === rs ? R_SHOULDER : L_SHOULDER)

  const midBx = (lsUse.x + rsUse.x) / 2
  const midBy = (lsUse.y + rsUse.y) / 2
  const mid = bodyToGoal(midBx, midBy)

  const nose = j[NOSE]
  // Nose fallback: roughly 0.6 shoulder widths above the shoulder midpoint.
  const headSrc = nose && vis(nose) >= 0.3 ? bodyToGoal(nose.x, nose.y) : bodyToGoal(midBx, midBy - 0.6)

  const torsoTop: Vec3 = { x: headSrc.x, y: Math.max(0.15, headSrc.y - 0.1), z: KEEPER_Z }
  const torsoBottom: Vec3 = { x: mid.x, y: Math.max(0.15, mid.y - 0.75), z: KEEPER_Z }

  return { left, right, torsoTop, torsoBottom, tracked: true }
}

/** Mouse fallback: gloves gather around a goal-plane point. */
export function pointerPose(target: { x: number; y: number }): KeeperPose {
  const pose: KeeperPose = {
    left: { x: 0, y: 0, z: 0 },
    right: { x: 0, y: 0, z: 0 },
    torsoTop: { x: 0, y: 0, z: 0 },
    torsoBottom: { x: 0, y: 0, z: 0 },
    tracked: false,
  }
  return pointerPoseInto(pose, target)
}

/** pointerPose without allocating: writes into dst (used every frame in mouse/keyboard mode). */
export function pointerPoseInto(dst: KeeperPose, target: { x: number; y: number }): KeeperPose {
  const topY = Math.max(target.y - 0.2, 0.9)
  const tx = target.x * 0.6
  dst.left.x = target.x - 0.3
  dst.left.y = target.y
  dst.left.z = KEEPER_Z
  dst.right.x = target.x + 0.3
  dst.right.y = target.y
  dst.right.z = KEEPER_Z
  dst.torsoTop.x = tx
  dst.torsoTop.y = topY
  dst.torsoTop.z = KEEPER_Z
  dst.torsoBottom.x = tx
  dst.torsoBottom.y = Math.max(0.15, topY - 0.75)
  dst.torsoBottom.z = KEEPER_Z
  dst.tracked = false
  return dst
}
