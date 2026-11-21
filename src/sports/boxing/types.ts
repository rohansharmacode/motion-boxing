// Boxing contract. Change only with the orchestrator.
import type { BodyFrame, Calibration, CalibrationStatus, Hand, StartupErrorKind } from '../../pose/types.ts'

export type PunchKind = 'jab' | 'cross' | 'hook' | 'uppercut'
export type SlipKind = 'left' | 'right' | 'duck'

export interface Punch {
  kind: PunchKind
  hand: Hand
  /** ms: BodyFrame.t for pose punches, performance.now() for keyboard punches. */
  t: number
  /** Peak wrist speed in shoulder widths per second. */
  peakVelocity: number
  /** Elbow angle at trigger in degrees (180 = straight arm). */
  elbowAngle: number
  source: 'pose' | 'keyboard'
}

export interface BoxingActions {
  /** New punches since the last update. */
  punches: Punch[]
  /** True while the guard is held. */
  guard: boolean
  /** Current slip or duck, null when upright. */
  slip: SlipKind | null
  /** Live numbers for the debug panel. */
  debug: Record<string, number>
}

export interface BoxingDetector {
  update(body: BodyFrame | null): BoxingActions
  reset(): void
}

export interface PunchCounts {
  total: number
  jab: number
  cross: number
  hook: number
  uppercut: number
  landed: number
}

export type RoundOutcome = 'ko-win' | 'ko-loss' | 'time'

export interface RoundResult {
  outcome: RoundOutcome
  playerHp: number
  droneHp: number
  counts: PunchCounts
  blocks: number
  dodges: number
  hitsTaken: number
  /** Best punch speed, shoulder widths per second. */
  bestSpeed: number
  /** landed / total * 100, 0 when no punches. */
  accuracyPct: number
}

export type HitTarget = 'head' | 'chest'

export interface HitResult {
  target: HitTarget
  /** 0 to 100, how centred the glove was on the target. */
  accuracy: number
}

export interface BoxingScene {
  readonly canvas: HTMLCanvasElement
  resize(width: number, height: number): void
  /** Drive glove targets from the tracked body (spring-lerp). null: gloves ease back to a guard pose. */
  setBody(body: BodyFrame | null): void
  /** Play a punch animation on one glove, layered on top of tracking. */
  punch(hand: Hand, kind: PunchKind): void
  /** Generous arcade hit test of that glove against the drone head and chest spheres. */
  resolveHit(hand: Hand, kind: PunchKind): HitResult | null
  setGuard(on: boolean): void
  /** Lean or drop the camera a little so slips and ducks feel physical. */
  setSlip(slip: SlipKind | null): void
  /** Start the red ring charge on the drone for ms milliseconds. */
  droneTelegraph(ms: number): void
  /** The drone strikes toward the camera. */
  droneStrike(): void
  droneHit(result: HitResult, damage: number, counter: boolean): void
  /** The player was hit. blocked = sparks on the gloves instead of a red flash. */
  playerHit(blocked: boolean): void
  droneKO(): void
  /** Reset the drone and effects for a new round. */
  resetRound(): void
  /** Freeze scene animation for ms milliseconds (impact feel). */
  hitstop(ms: number): void
  /** Advance animations by real elapsed time. */
  update(dtMs: number): void
  render(): void
  dispose(): void
}

export interface BoxingHud {
  /** Start screen. onCamera starts the webcam flow, onKeyboard starts keyboard-only play. */
  showStart(onCamera: () => void, onKeyboard: () => void): void
  showLoading(text: string): void
  showError(kind: StartupErrorKind, onRetry: () => void, onKeyboard: () => void): void
  /** 2 s hold-stance gate: progress 0 to 1. */
  showCalibration(progress: number, status: CalibrationStatus): void
  showFight(): void
  /** 0 to 100 each. */
  setHp(player: number, drone: number): void
  setTimer(msLeft: number): void
  setCounts(counts: PunchCounts): void
  flashPunch(punch: Punch, landed: boolean, counter: boolean): void
  /** Short callout such as BLOCKED, SLIPPED, COUNTER, HIT. */
  callout(text: string, tone: 'good' | 'bad' | 'info'): void
  setGuard(on: boolean): void
  /** Edge warning while the drone charges an attack. */
  setTelegraph(on: boolean): void
  setKeyboardMode(on: boolean): void
  showRoundEnd(result: RoundResult, onAgain: () => void): void
  setDebug(values: Record<string, number | string>): void
  toggleDebug(): void
}

/** event_type values used by boxing (MOTION_EVENTS table, research doc section 5). */
export type MotionEventType = 'PUNCH' | 'BLOCK' | 'DODGE' | 'TICK'

/** detail of window CustomEvent 'motion-event'. Field names match the MOTION_EVENTS columns exactly. */
export interface MotionEventDetail {
  event_id: string
  session_id: string
  player_id: string
  sport: 'BOXING'
  /** ISO 8601 UTC timestamp. */
  event_ts: string
  /** Integer ms since round start. */
  round_ms: number
  event_type: MotionEventType
  /** Shoulder widths per second. */
  peak_velocity: number | null
  /** ms from drone telegraph start to the player's response. */
  reaction_ms: number | null
  /** 0 to 100. */
  accuracy_score: number | null
  /** Left/right balance 0 to 1 (min / max of left and right punch counts). */
  symmetry_ratio: number | null
  /** Sport-specific JSON, for example { punchType, hand, elbowAngle, landed, target, damage, counter, source }. */
  metrics: Record<string, unknown>
}

export interface MotionEventInput {
  event_type: MotionEventType
  peak_velocity?: number | null
  reaction_ms?: number | null
  accuracy_score?: number | null
  symmetry_ratio?: number | null
  metrics?: Record<string, unknown>
}

export interface Telemetry {
  readonly playerId: string
  readonly sessionId: string
  /** New session_id and round clock zero. */
  startRound(): void
  /** Fill ids and timestamps, dispatch window CustomEvent('motion-event', { detail }), return the detail. */
  emit(input: MotionEventInput): MotionEventDetail
}

export interface KeyboardFallback {
  readonly enabled: boolean
  setEnabled(on: boolean): void
  /** Returns the new enabled state. */
  toggle(): boolean
  /** Punches since the last poll; guard and slip reflect held keys. Empty and false when disabled. */
  poll(): BoxingActions
  dispose(): void
}

/** Research doc section 4 SportEngine pattern. */
export interface SportEngine<TScene> {
  init(scene: TScene, calibration: Calibration): void
  onPoseFrame(body: BodyFrame | null): void
  update(dtMs: number): void
  flushTelemetry(): void
  dispose(): void
}

export type BoxingPhase = 'idle' | 'fighting' | 'ended'

export interface BoxingEngine extends SportEngine<BoxingScene> {
  readonly phase: BoxingPhase
  /** Keyboard path. Same rules as pose actions. */
  onActions(actions: BoxingActions): void
  startRound(): void
  /** Register a callback that runs once per round end. */
  onRoundEnd(cb: (result: RoundResult) => void): void
  /** Latest detector debug values plus engine values. */
  readonly debug: Record<string, number | string>
}
