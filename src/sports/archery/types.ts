// Archery ("Aero Bow") contract. Research doc section 3 (Sport 3) and section 4.
// Change only with the orchestrator. Every archery module codes against this file.
//
// WORLD FRAME (Three.js, metres, y up):
//   The archer stands at the origin and shoots toward -z. +x is screen right.
//   The target face is a disc in the plane z = TARGET_Z, centre TARGET_CENTER (it drifts sideways on
//   the wind arrows). The main camera sits at EYE looking at the target centre.
//   Arrows launch from LAUNCH_POS. Ground is the plane y = 0.
//
// POSE (camera mode): the player faces the screen. One arm pushes out to the side (bow hand, straight
// elbow), the other pulls back across the chest (draw hand, bent elbow). Pulling the wrists apart
// horizontally is the draw. A fast snap or drop of the draw hand is the release.
// Body space (src/pose/types.ts BodyFrame.body) is mirrored, in shoulder widths (SW), y DOWN.
// Every Vec2 called "aim" in this file is y UP.

import type { BodyFrame, Calibration, CalibrationStatus, Hand } from '../../pose/types.ts'

export type { BodyFrame, Calibration, CalibrationStatus, Hand }

export interface Vec2 {
  x: number
  y: number
}

export interface Vec3 {
  x: number
  y: number
  z: number
}

// ---------- shared constants ----------

export const ARROWS_PER_ROUND = 5
/** 0-based index of the first arrow with wind and target drift (shots 4 and 5). */
export const WIND_FIRST_ARROW = 3

export const TARGET_Z = -25
/** Rest position of the target centre on its plane (x, y). */
export const TARGET_CENTER: Readonly<Vec2> = { x: 0, y: 1.5 }
/** Outer radius of the scoring face, metres. */
export const TARGET_RADIUS = 1.0
export const RING_COUNT = 10
/** Score = 10 - floor(r / RING_WIDTH); r >= TARGET_RADIUS scores 0 (miss). */
export const RING_WIDTH = TARGET_RADIUS / RING_COUNT

export const EYE: Readonly<Vec3> = { x: 0, y: 1.6, z: 0 }
export const LAUNCH_POS: Readonly<Vec3> = { x: 0, y: 1.5, z: -0.4 }
/** m/s^2, applied as -GRAVITY on y. */
export const GRAVITY = 9.81
/** Launch speed v0 = V0_BASE + V0_GAIN * tension, m/s (doc: 28 + 22 * tension). */
export const V0_BASE = 28
export const V0_GAIN = 22

/** Draw is armed once tension > ARM_TENSION for at least ARM_HOLD_MS. */
export const ARM_TENSION = 0.7
export const ARM_HOLD_MS = 250
/** Aim stability is RMS(raw - filtered bow wrist) over this window before release. */
export const SWAY_WINDOW_MS = 800

// ---------- draw detection (detector.ts camera, engine.ts mouse) ----------

/** idle: no draw. drawing: tension building, not armed yet. armed: release allowed. */
export type DrawPhase = 'idle' | 'drawing' | 'armed'

export type ReleaseTrigger = 'snap' | 'drop' | 'mouse' | 'key'

export interface ReleaseInfo {
  /** ms, same clock as BodyFrame.t / performance.now(). */
  t: number
  /** Tension sampled about 100 ms before the release motion started, 0..1. */
  tension: number
  /** Aim offset (see DrawSample.aim) sampled about 100 ms before release, so the snap does not spoil the shot. */
  aim: Vec2
  bowHand: Hand
  trigger: ReleaseTrigger
  /** Peak draw-hand speed during the release, SW/s. 0 for mouse/key. */
  peakVelocity: number
  /** RMS(raw - filtered bow wrist) over the final SWAY_WINDOW_MS, shoulder widths. */
  rmsSway: number
  /** rmsSway converted to millimetres with calibration.shoulderWidthWorld. */
  rmsSwayMm: number
  /** 0..100, from stabilityScore(rmsSwayMm). */
  stability: number
  /** ms from armed to release. */
  holdMs: number
  /** 3D elbow angles at release, degrees. NaN when unknown (mouse). */
  bowElbowDeg: number
  drawElbowDeg: number
}

/** What the detector reports for every pose frame. */
export interface DrawSample {
  t: number
  /** Shoulders and both wrists usable this frame. */
  tracked: boolean
  phase: DrawPhase
  /** 0..1. |x_bow - x_draw| / S mapped from [0.5, 1.6] SW. */
  tension: number
  /** Hand holding the bow (straight arm), locked when a draw starts. null when idle and unknown. */
  bowHand: Hand | null
  /**
   * Bow wrist offset since the bow was armed, shoulder widths, x screen right, y UP. Dual-regime
   * 1-euro filtered (calm reticle once drawn). (0, 0) when not armed.
   */
  aim: Vec2
  /** Live RMS sway over the trailing SWAY_WINDOW_MS while armed, millimetres. null when not armed. */
  swayMm: number | null
  /** Non-null only on the single frame a release fires. */
  release: ReleaseInfo | null
}

export interface ArcheryDetector {
  /** Feed every BodyFrame in time order (null when no pose). */
  push(body: BodyFrame | null): DrawSample
  /** Back to idle (new arrow). Keeps the learned handedness preference. */
  reset(): void
  readonly debug: Record<string, number | string>
}

// ---------- physics (physics.ts, pure, no Three.js) ----------
// physics.ts exports these functions with exactly these signatures:
//   launchSpeed(tension: number): number
//     V0_BASE + V0_GAIN * clamp01(tension).
//   solveLaunch(from: Vec3, aim: Vec3, speed: number): Vec3
//     Launch velocity (flat-trajectory solution, gravity only) that passes through aim. If aim is out of
//     range, the 45 degree velocity toward it.
//   simulateShot(opts: ShotInput): ShotFlight
//     Integrates v += (g + wind) * dt, p += v * dt from launch until the arrow crosses z = TARGET_Z
//     (segment raycast p_prev -> p_curr against the plane) or hits the ground (y <= 0) or times out.
//   ringScore(r: number): number
//     10 - floor(r / RING_WIDTH) for r < TARGET_RADIUS, else 0.
//   windForArrow(arrow: number, rng: () => number): number
//     Lateral wind acceleration, m/s^2 (+x). 0 for arrow < WIND_FIRST_ARROW.
//   targetCenterAt(arrow: number, tMs: number, phase: number): Vec2
//     Target centre at round time tMs. TARGET_CENTER for arrow < WIND_FIRST_ARROW, slow sideways
//     drift afterwards. phase is a per-arrow random 0..2*PI.

export interface ShotInput {
  from: Vec3
  velocity: Vec3
  /** m/s^2 along +x. */
  windAccel: number
  /** Target centre at ms since launch (lets the drifting target be hit where it is at impact). */
  targetCenterAt: (msSinceLaunch: number) => Vec2
}

export interface ShotFlight {
  /** Arrow positions from launch to the end (last = impact or ground point), one per PHYS step. */
  path: Vec3[]
  /** Velocity at each path point (same length as path). */
  vel: Vec3[]
  /** Seconds between path samples. */
  stepS: number
  flightMs: number
  /** 'target': crossed the target plane (score may still be 0 if off the face). 'ground': landed short. */
  end: 'target' | 'ground'
  /** Point where the flight ended. */
  impact: Vec3
  /** Impact offset from the target centre at impact time, on the target plane. null for 'ground'. */
  hit: Vec2 | null
  /** |hit| in metres. Infinity for 'ground'. */
  radius: number
  /** 0..10. */
  score: number
  /** Lateral metres the wind moved the arrow at the target plane (impact.x minus the no-wind x). */
  windErrX: number
  /** Target centre at impact time. */
  targetCenter: Vec2
}

// ---------- scene (scene.ts, Three.js) ----------

export interface ArcheryScene {
  readonly canvas: HTMLCanvasElement
  resize(width: number, height: number): void
  /** First-person bow. tension 0..1 pulls string and arrow back. bowHand picks the side (player's left shows screen left). nocked: arrow on the string. */
  setBow(tension: number, bowHand: Hand, nocked: boolean): void
  /** Aim reticle at a point on the target plane (world x, y). null hides. steadiness 0..1 tightens and greens it. */
  setReticle(p: Vec2 | null, steadiness: number): void
  /** Target centre on its plane (drift). */
  setTarget(center: Vec2): void
  /** Lateral wind, m/s^2 (+x right). 0 hides wind flags and streaks. */
  setWind(accel: number): void
  /** Flying arrow. dir is the velocity (the mesh points along it). visible false hides it. */
  setArrow(p: Vec3, dir: Vec3, visible: boolean): void
  /** Arrow sticks into the target face at p and stays (moves with the target) until reset(). score 0..10 flashes that ring. */
  stickArrow(p: Vec3, dir: Vec3, score: number): void
  /** Arrow lands in the ground or backstop at p and stays until reset(). */
  missArrow(p: Vec3, dir: Vec3): void
  /** Bullseye slow-mo: camera chases the flying arrow (true), or returns to the archer view (false). */
  setFollowCam(on: boolean): void
  /** Camera shake, 0..1. */
  shake(intensity: number): void
  /** Mouse fallback: normalised device coords (-1..1, y up) to the point on the target plane. */
  screenToTarget(ndcX: number, ndcY: number): Vec2
  /** Remove stuck arrows and effects for a new round. */
  reset(): void
  /** Advance animations by game-time ms (host passes dt * engine.timeScale). */
  update(dtMs: number): void
  render(): void
  dispose(): void
}

// ---------- engine (engine.ts) ----------

/** Research doc section 4 SportEngine pattern (same shape as boxing's and goalkeeper's). */
export interface SportEngine<TScene> {
  init(scene: TScene, calibration: Calibration | null): void
  onPoseFrame(body: BodyFrame | null): void
  update(dtMs: number): void
  flushTelemetry(): void
  dispose(): void
}

/** nock: arrow appears (short beat). aiming: draw/hold/release. flight: arrow in the air. impact: score shown. */
export type ArcheryPhase = 'idle' | 'nock' | 'aiming' | 'flight' | 'impact' | 'ended'

export type InputSource = 'camera' | 'mouse'

export interface ShotResult {
  /** 0-based arrow number. */
  arrow: number
  /** 0..10 ring score (0 = miss). */
  score: number
  bullseye: boolean
  /** Hit offset from the target centre, metres. null when the arrow landed short. */
  hit: Vec2 | null
  radius: number
  tension: number
  launchSpeed: number
  flightMs: number
  /** m/s^2, 0 on arrows before WIND_FIRST_ARROW. */
  wind: number
  windErrX: number
  rmsSway: number
  rmsSwayMm: number
  stability: number
  holdMs: number
  /** Draw-hand release speed, SW/s. 0 for mouse. */
  peakVelocity: number
  bowHand: Hand | null
  trigger: ReleaseTrigger
  source: InputSource
}

export interface RoundResult {
  shots: ShotResult[]
  /** Sum of ring scores, 0..50. */
  total: number
  bullseyes: number
  /** Mean stability 0..100 over shots. */
  avgStability: number
  bestStability: number
  /** Mean distance of target hits from their centroid, metres. null with fewer than 2 hits. */
  grouping: number | null
  /** Arcade score: total * 100 + bonuses (bullseyes, stability). */
  score: number
}

/** Live values the HUD shows every frame. */
export interface ArcheryView {
  phase: ArcheryPhase
  arrow: number
  tension: number
  drawPhase: DrawPhase
  /** 0..1 while armed, null otherwise. */
  steadiness: number | null
  /** Coaching line for the camera player ("Push your bow arm out", "Hold…", "Release!"). null hides. */
  hint: string | null
  /** m/s^2 for the current arrow. */
  wind: number
}

export interface ArcheryEngine extends SportEngine<ArcheryScene> {
  readonly phase: ArcheryPhase
  /** Arrows shot so far this round (0..ARROWS_PER_ROUND). */
  readonly arrowIndex: number
  readonly shots: readonly ShotResult[]
  readonly view: ArcheryView
  startRound(): void
  /**
   * Mouse fallback. aim: target-plane point (from scene.screenToTarget). drawing: button or Space held.
   * Tension ramps while drawing; letting go once armed releases. Overrides pose while non-null.
   */
  setMouse(state: { aim: Vec2; drawing: boolean } | null): void
  /** Each arrow leaves the bow (sfx twang, HUD). */
  onRelease(cb: (info: ReleaseInfo, arrow: number) => void): void
  /** Each arrow lands (score known). */
  onShot(cb: (r: ShotResult) => void): void
  onPhase(cb: (phase: ArcheryPhase, arrow: number) => void): void
  onRoundEnd(cb: (r: RoundResult) => void): void
  /** Game-world speed, below 1 during bullseye slow-mo. Hosts pass dt * timeScale to scene.update. */
  readonly timeScale: number
  readonly debug: Record<string, number | string>
}

// ---------- telemetry (telemetry.ts) ----------

export type ArcheryEventType = 'ARROW_RELEASE' | 'TICK'

/** detail of window CustomEvent 'motion-event'. Field names match MOTION_EVENTS columns (research doc section 5). */
export interface ArcheryMotionEvent {
  event_id: string
  session_id: string
  player_id: string
  sport: 'ARCHERY'
  /** ISO 8601 UTC. */
  event_ts: string
  /** Integer ms since round start. */
  round_ms: number
  event_type: ArcheryEventType
  /** Draw-hand release speed, shoulder widths per second. */
  peak_velocity: number | null
  reaction_ms: number | null
  /** 0..100 (ring score * 10). */
  accuracy_score: number | null
  symmetry_ratio: number | null
  /** e.g. { arrow, score, ring, bullseye, hitX, hitY, radius, tension, launchSpeed, flightMs, wind, windErrX, rmsSway, rmsSwayMm, stability, holdMs, bowHand, trigger, source } */
  metrics: Record<string, unknown>
}

export interface ArcheryEventInput {
  event_type: ArcheryEventType
  peak_velocity?: number | null
  reaction_ms?: number | null
  accuracy_score?: number | null
  symmetry_ratio?: number | null
  metrics?: Record<string, unknown>
}

export interface ArcheryTelemetry {
  readonly playerId: string
  readonly sessionId: string
  /** New session_id and round clock zero. */
  startRound(): void
  /** Fill ids and timestamps, dispatch window CustomEvent('motion-event', { detail }) now, return the detail. */
  emit(input: ArcheryEventInput): ArcheryMotionEvent
  /** Buffer a TICK (5 Hz summary) without dispatching. */
  queueTick(input: Omit<ArcheryEventInput, 'event_type'>): void
  /** Dispatch buffered TICKs and clear the buffer. Returns how many were sent. */
  flush(): number
}

// ---------- HUD (hud.ts, DOM) ----------

export type InputMode = InputSource

export type CalloutTone = 'good' | 'bad' | 'info' | 'gold'

export interface ArcheryHud {
  showStart(onCamera: () => void, onMouse: () => void): void
  showLoading(text: string): void
  showError(message: string, onRetry: () => void, onMouse: () => void): void
  /** 2 s hold-stance gate: progress 0..1. */
  showCalibration(progress: number, status: CalibrationStatus): void
  showPlay(): void
  /** Ring scores so far plus pips for the remaining arrows (arrows = ARROWS_PER_ROUND). The running total is summed from shots. */
  setScoreboard(shots: readonly ShotResult[], arrows: number): void
  /** Per-frame live values: draw meter, phase label, steadiness, hint, wind gauge. */
  setView(view: ArcheryView): void
  /** Big ring-score popup for one shot (10 = gold BULLSEYE). */
  showShot(r: ShotResult): void
  /** Short callout such as WIND!, LAST ARROW, LET DOWN. */
  callout(text: string, tone: CalloutTone): void
  setInputMode(mode: InputMode): void
  /** Result screen: total, per-arrow scores, stability, grouping, Again and Home. */
  showEnd(result: RoundResult, onAgain: () => void): void
  setDebug(values: Record<string, number | string>): void
  toggleDebug(): void
  dispose(): void
}
