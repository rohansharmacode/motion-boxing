// Shared contract for motion-boxing. Change only with the orchestrator.

/** One MediaPipe landmark. */
export interface Landmark {
  x: number
  y: number
  z: number
  /** 0 to 1, how likely the point is visible. Missing in MediaPipe output means 0. */
  visibility: number
}

/**
 * One tracked pose. x is MIRRORED once at the source (src/pose.ts), so the screen shows
 * a mirror image: the player's left hand appears on the screen's left.
 * y points down in both arrays. Indices follow MediaPipe (see LM).
 */
export interface PoseFrame {
  /** performance.now() in ms when the frame was processed. Strictly increasing. */
  t: number
  /** 33 landmarks. x = 1 - raw.x, y = raw.y (0 to 1 of the video frame). z = raw.z (smaller is closer to the camera). */
  image: Landmark[]
  /** 33 landmarks in metres, origin at the hip midpoint. x = -raw.x, y = raw.y (down), z = raw.z (smaller is closer to the camera). */
  world: Landmark[]
}

/** MediaPipe pose landmark indices. L and R are the player's own (anatomical) left and right. */
export const LM = {
  NOSE: 0,
  L_SHOULDER: 11,
  R_SHOULDER: 12,
  L_ELBOW: 13,
  R_ELBOW: 14,
  L_WRIST: 15,
  R_WRIST: 16,
  L_HIP: 23,
  R_HIP: 24,
} as const

/** The player's own hand. */
export type Hand = 'left' | 'right'

export type PunchType = 'jab' | 'hook'

/** One detected punch. Also the Snowflake row shape in a later milestone. */
export interface PunchEvent {
  type: PunchType
  hand: Hand
  /** PoseFrame.t of the frame that triggered the punch, in ms. */
  t: number
  /** Wrist speed in shoulder widths per second when the punch triggered. */
  speed: number
}

export interface DetectorOutput {
  /** Punches detected on this update. Usually empty, at most one per hand. */
  punches: PunchEvent[]
  /** True while a block is held. */
  blocking: boolean
  /** Live values for the debug panel. */
  debug: Record<string, number>
}

export interface Detector {
  /** Feed every frame in time order. Pass null when no pose is tracked. */
  update(frame: PoseFrame | null): DetectorOutput
  /** Clear all motion history, lockouts and block state. */
  reset(): void
}

/** Why startup failed. pose.ts throws it, hud.ts shows matching copy. */
export type StartupErrorKind =
  | 'camera-denied'
  | 'camera-not-found'
  | 'camera-in-use'
  | 'camera-unsupported'
  | 'camera-other'
  | 'tracker-failed'

export class StartupError extends Error {
  readonly kind: StartupErrorKind
  constructor(kind: StartupErrorKind, message: string) {
    super(message)
    this.name = 'StartupError'
    this.kind = kind
  }
}
