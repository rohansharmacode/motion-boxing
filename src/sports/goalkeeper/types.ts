// Goalkeeper ("Reflex Keeper") contract. Research doc section 3 (Sport 2) and section 4.
// Change only with the orchestrator. Every goalkeeper module codes against this file.
//
// WORLD FRAME (Three.js, metres, y up):
//   Goal mouth lies in the plane z = GOAL_Z = 0. x spans [-3.66, +3.66], y spans [0, 2.44].
//   The striker stands at the penalty spot, z = -11. The ball travels toward +z.
//   The camera sits behind the keeper (z > 0) looking toward -z, so +x is screen right.
//   Body space x (mirror view, screen right) maps to +x, so the player's movement matches the screen.
//
// ZONES: 9-zone grid, index = row * 3 + col. row 0 = top, row 2 = bottom. col 0 = screen left (-x), col 2 = screen right.

import type { BodyFrame, Calibration, CalibrationStatus } from '../../pose/types.ts'

export type { BodyFrame, Calibration, CalibrationStatus }

export interface Vec3 {
  x: number
  y: number
  z: number
}

// ---------- constants (physics.ts exports these values under the same names) ----------
// GOAL_HALF_WIDTH = 3.66, GOAL_HEIGHT = 2.44, GOAL_Z = 0, PENALTY_Z = -11
// BALL_RADIUS = 0.11, GLOVE_RADIUS = 0.38 (generous arcade), TORSO_RADIUS = 0.28
// GRAVITY = -9.81 (y), RESTITUTION = 0.65, PHYS_DT = 1 / 60, K_MAGNUS (tuned so spin curves 0.3 to 1.0 m)

export type Zone = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

export interface BallState {
  /** Centre position, metres. */
  p: Vec3
  /** Velocity, m/s. */
  v: Vec3
  /** Spin, rad/s. Magnus: a = g + K_MAGNUS * (omega x v). */
  omega: Vec3
}

/** Result of a swept test. t is the fraction 0..1 along the step where contact starts. */
export interface SweptHit {
  t: number
  /** Ball centre at contact. */
  point: Vec3
  /** Unit contact normal, from the collider toward the ball. */
  normal: Vec3
}

/** Keeper collision and render pose in world metres. Built by mapping.ts, filtered by the engine. */
export interface KeeperPose {
  /** Player's own left glove (shows on screen left in the mirror view). */
  left: Vec3
  right: Vec3
  /** Torso capsule segment: top (head/nose end) and bottom (waist end). */
  torsoTop: Vec3
  torsoBottom: Vec3
  /** False when this pose came from a fallback (no body). */
  tracked: boolean
}

export type KeeperPart = 'left' | 'right' | 'torso'

// ---------- striker ----------

/** idle: waiting at the ball. runup: approach (~1 s). telegraph: 0.5 s plant with subtle lean. kick: strike frame. recover: after the kick. */
export type StrikerPhase = 'idle' | 'runup' | 'telegraph' | 'kick' | 'recover'

/** Subtle tell shown during the telegraph. side: -1 aims screen left, 0 centre, 1 right. high: lean back for a top-row shot. */
export interface StrikerTell {
  side: -1 | 0 | 1
  high: boolean
}

/** One planned kick, chosen by striker.ts. */
export interface KickPlan {
  zone: Zone
  /** Aim point in the goal plane (z = GOAL_Z). */
  target: Vec3
  /** Spin, rad/s. */
  omega: Vec3
  /** Seconds from strike to the goal plane. */
  flightTime: number
  tell: StrikerTell
}

// ---------- scene (scene.ts, Three.js) ----------

export interface KeeperScene {
  readonly canvas: HTMLCanvasElement
  resize(width: number, height: number): void
  /** Draw the gloves and a faint torso ghost. null: gloves ease to a ready pose. */
  setKeeper(pose: KeeperPose | null): void
  /** Ball transform. visible false hides it (between kicks). */
  setBall(p: Vec3, omega: Vec3, visible: boolean): void
  /** Drive the striker bot. progress is 0..1 within the phase. tell only matters in telegraph. */
  setStriker(phase: StrikerPhase, progress: number, tell: StrikerTell): void
  /** Save burst at the contact point on that part. strength 0..1. */
  flashSave(point: Vec3, part: KeeperPart, strength: number): void
  /** Net ripple and red flash where the ball crossed the line. */
  flashGoal(point: Vec3): void
  /** Briefly light one zone of the grid (result feedback). null clears. */
  highlightZone(zone: Zone | null, tone: 'save' | 'goal' | 'info'): void
  /** Camera shake, 0..1. */
  shake(intensity: number): void
  /** Mouse fallback: normalised device coords (-1..1, y up) to a point on the goal plane z = 0. */
  screenToGoal(ndcX: number, ndcY: number): { x: number; y: number }
  /** Clear effects and reset the striker for a new shootout. */
  reset(): void
  /** Advance animations by real elapsed ms. */
  update(dtMs: number): void
  render(): void
  dispose(): void
}

// ---------- engine ----------

/** Research doc section 4 SportEngine pattern (same shape as boxing's). */
export interface SportEngine<TScene> {
  init(scene: TScene, calibration: Calibration | null): void
  onPoseFrame(body: BodyFrame | null): void
  update(dtMs: number): void
  flushTelemetry(): void
  dispose(): void
}

export type KickOutcome = 'save' | 'goal'

export interface KickResult {
  /** 0-based kick number within the shootout. */
  kick: number
  outcome: KickOutcome
  zone: Zone
  /** Which part saved it. null for a goal. */
  part: KeeperPart | null
  /** ms from telegraph start to the first decisive glove move. null if none. */
  reactionMs: number | null
  /** Peak glove speed during the flight, shoulder widths per second (m/s converted with calibrated shoulder width). */
  peakVelocity: number
  /** 0..100. Save: how centred the contact was. Goal: how close the nearest glove got. */
  accuracy: number
  /** True when glove speed toward the ball was high enough for a punch clearance. */
  punch: boolean
  ballSpeed: number
}

export interface ShootoutResult {
  kicks: KickResult[]
  saves: number
  goals: number
  /** Mean reaction over kicks that had one, ms. null if none. */
  avgReactionMs: number | null
  bestPeakVelocity: number
  /** Arcade score: saves * 1000 + bonuses (fast reaction, punch clearance). */
  score: number
}

export type KeeperPhase = 'idle' | 'playing' | 'ended'

export interface KeeperEngine extends SportEngine<KeeperScene> {
  readonly phase: KeeperPhase
  /** Kicks taken so far this shootout (0..KICKS_PER_SHOOTOUT). */
  readonly kickIndex: number
  readonly results: readonly KickResult[]
  /** Start a 5-kick shootout. */
  startShootout(): void
  /** Mouse fallback. A goal-plane point both gloves gather around; overrides pose while non-null. */
  setPointer(target: { x: number; y: number } | null): void
  onKickResult(cb: (r: KickResult) => void): void
  /** Called on every striker phase change, for HUD cues. */
  onStrikerPhase(cb: (phase: StrikerPhase, kick: number) => void): void
  onShootoutEnd(cb: (r: ShootoutResult) => void): void
  /** Game-world speed, below 1 during the save/goal slow-mo. Hosts pass dt * timeScale to scene.update. */
  readonly timeScale: number
  readonly debug: Record<string, number | string>
}

export const KICKS_PER_SHOOTOUT = 5

// ---------- telemetry (telemetry.ts) ----------

export type KeeperEventType = 'SAVE' | 'GOAL' | 'TICK'

/** detail of window CustomEvent 'motion-event'. Field names match MOTION_EVENTS columns (research doc section 5). */
export interface KeeperMotionEvent {
  event_id: string
  session_id: string
  player_id: string
  sport: 'GOALKEEPER'
  /** ISO 8601 UTC. */
  event_ts: string
  /** Integer ms since shootout start. */
  round_ms: number
  event_type: KeeperEventType
  /** Shoulder widths per second. */
  peak_velocity: number | null
  /** ms from striker telegraph start to the keeper's response. */
  reaction_ms: number | null
  /** 0..100. */
  accuracy_score: number | null
  /** Left/right glove usage balance 0..1. */
  symmetry_ratio: number | null
  /** e.g. { kick, zone, row, col, part, punch, ballSpeed, spin, flightTime, source } */
  metrics: Record<string, unknown>
}

export interface KeeperEventInput {
  event_type: KeeperEventType
  peak_velocity?: number | null
  reaction_ms?: number | null
  accuracy_score?: number | null
  symmetry_ratio?: number | null
  metrics?: Record<string, unknown>
}

export interface KeeperTelemetry {
  readonly playerId: string
  readonly sessionId: string
  /** New session_id and round clock zero. */
  startRound(): void
  /** Fill ids and timestamps, dispatch window CustomEvent('motion-event', { detail }) now, return the detail. */
  emit(input: KeeperEventInput): KeeperMotionEvent
  /** Buffer a TICK (5 Hz summary) without dispatching. */
  queueTick(input: Omit<KeeperEventInput, 'event_type'>): void
  /** Dispatch all buffered TICKs as 'motion-event's and clear the buffer. Returns how many were sent. */
  flush(): number
}

// ---------- HUD (hud.ts, DOM) ----------

export type InputMode = 'camera' | 'mouse'

export interface KeeperHud {
  showStart(onCamera: () => void, onMouse: () => void): void
  showLoading(text: string): void
  showError(message: string, onRetry: () => void, onMouse: () => void): void
  /** 2 s hold-stance gate: progress 0..1. */
  showCalibration(progress: number, status: CalibrationStatus): void
  showPlay(): void
  /** results so far plus pips for the remaining kicks. */
  setScoreboard(results: readonly KickResult[], total: number): void
  /** Short callout such as SAVED!, GOAL, PUNCHED CLEAR, GET READY. */
  callout(text: string, tone: 'good' | 'bad' | 'info'): void
  setInputMode(mode: InputMode): void
  /** Faint edge pulse while the striker telegraphs (the 0.5 s stance tell). */
  setTelegraph(on: boolean): void
  showEnd(result: ShootoutResult, onAgain: () => void): void
  setDebug(values: Record<string, number | string>): void
  toggleDebug(): void
  dispose(): void
}
