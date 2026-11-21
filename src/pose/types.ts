// Shared pose contract. Change only with the orchestrator.

export interface Joint {
  x: number
  y: number
  z: number
  /** 0 to 1. Missing in MediaPipe output means 0. */
  visibility: number
}

/** One raw pose from the pipeline. x is mirrored once at the source. y points down. */
export interface PoseFrame {
  /** performance.now() in ms. Strictly increasing. */
  t: number
  /** 33 landmarks, 0 to 1 of the video frame. x = 1 - raw.x, y = raw.y, z = raw.z (smaller is closer). */
  image: Joint[]
  /** 33 landmarks in metres, hip midpoint origin. x = -raw.x, y = raw.y (down), z = raw.z (smaller is closer). */
  world: Joint[]
}

/** MediaPipe pose indices. L and R are the player's own left and right. */
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

/** Joints that are 1-euro filtered and used by game logic. */
export const TRACKED_JOINTS = [0, 11, 12, 13, 14, 15, 16] as const

export type Hand = 'left' | 'right'

/**
 * Result of the 2 s hold-stance gate (research doc, Shared Camera Calibration).
 * 2D values are in mirrored image coordinates with x multiplied by aspect (width / height),
 * so 2D distances are not distorted by the frame shape.
 */
export interface Calibration {
  /** Video width / height used for the aspect correction. */
  aspect: number
  /** S: 2D shoulder width ||P11 - P12|| in aspect-corrected image units. Never 0. */
  shoulderWidth: number
  /** Shoulder width in metres from world landmarks. Never 0. */
  shoulderWidthWorld: number
  /** C = (P11 + P12) / 2, aspect-corrected image units. */
  torsoCenter: { x: number; y: number }
  /** N0 = P0, aspect-corrected image units. */
  neutralNose: { x: number; y: number }
  /**
   * Lead side read from the hold stance: orthodox leads with the left hand, southpaw with the right.
   * Missing means unknown (keyboard play), treated as orthodox.
   */
  stance?: Stance
}

export type Stance = 'orthodox' | 'southpaw'

/**
 * no-pose: nobody in view. shoulders-hidden: shoulders not both visible. too-close: the player fills the frame,
 * so punches and reaches would leave it. hands-hidden: shoulders fine but a fist is out of view (raise both hands).
 */
export type CalibrationStatus = 'no-pose' | 'shoulders-hidden' | 'too-close' | 'hands-hidden' | 'holding' | 'done'

/** Smoothed, calibrated body for game logic (built by src/pose/body.ts). */
export interface BodyFrame {
  /** Same t as the source PoseFrame, ms. */
  t: number
  /**
   * 33 entries in BODY SPACE: origin at the calibrated torso centre C, unit = calibrated shoulder width S,
   * x to the screen right (mirror view), y down. TRACKED_JOINTS are 1-euro filtered. z is 0.
   * Example: neutral nose is near (0, -0.6), a wrist at x = 0.5 is half a shoulder width right of C.
   */
  body: Joint[]
  /** 33 world landmarks (metres, hip origin, mirrored x, y down). TRACKED_JOINTS are 1-euro filtered. */
  world: Joint[]
  /** Neutral nose N0 in body space. */
  neutralNose: { x: number; y: number }
  /** Live 2D shoulder width / calibrated shoulder width (1 when the player has not moved closer or further). */
  scale: number
  calibration: Calibration
}

/** Why startup failed. pipeline.ts throws it, the HUD shows matching copy. */
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
