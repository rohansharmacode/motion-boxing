// Boxing contract. Change only with the orchestrator.
import type { BodyFrame, Calibration, CalibrationStatus, Hand, StartupErrorKind } from '../../pose/types.ts'
import type { BotStance } from './botDefence.ts'

export type { BotStance }

/** One fighter's guard stamina for the rings. */
export interface GuardMeterView {
  /** 0 to 1. */
  fraction: number
  broken: boolean
}

export type PunchKind = 'jab' | 'cross' | 'hook' | 'uppercut'
export type SlipKind = 'left' | 'right' | 'duck'

/**
 * Drone attack patterns. Every attack has a 600 ms telegraph; blocking cuts damage by 80 percent.
 * straight: fast jab at the head. A slip (left or right) or a duck dodges it.
 * hook: wide swing from the side. Only a duck dodges it.
 * slam: overhead smash. Only a slip (left or right) dodges it.
 */
export type AttackPattern = 'straight' | 'hook' | 'slam'

export type QualityLevel = 'high' | 'low'

/** Per-round log for the coach. Times are round ms. */
export interface RoundLog {
  roundMs: number
  punches: Array<{ kind: PunchKind; hand: Hand; t: number; speed: number; landed: boolean; counter: boolean; combo: number }>
  defences: Array<{ pattern: AttackPattern; t: number; outcome: 'blocked' | 'dodged' | 'hit'; reactionMs: number | null }>
  /** Total ms with the guard up while fighting. */
  guardMs: number
}

/** Post-match coach card (research doc section 5). */
export interface CoachCard {
  /** Original play-style badge, for example "PRESSURE ARTIST". */
  badge: string
  headline: string
  tips: [string, string, string]
  drill: string
  source: 'cortex' | 'local' | 'demo'
}

export interface BoxingSfx {
  /** Call from a user gesture so audio can start. Safe to call many times. */
  unlock(): void
  punch(kind: PunchKind, landed: boolean, counter: boolean): void
  combo(count: number): void
  telegraph(pattern: AttackPattern): void
  block(): void
  dodge(): void
  playerHit(): void
  bell(): void
  ko(win: boolean): void
  /** Round-start countdown beat: 3, 2, 1, then 0 for FIGHT. */
  countdown?(n: number): void
  /** The finishing blow: a heavy crunch and a metal pop as the head comes off. */
  finisher?(): void
  setMuted(muted: boolean): void
  dispose(): void
}

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
  /** Longest chain of landed punches. */
  maxCombo: number
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
  droneTelegraph(ms: number, pattern: AttackPattern): void
  /** The drone strikes toward the camera. */
  droneStrike(pattern: AttackPattern): void
  droneHit(result: HitResult, damage: number, counter: boolean): void
  /** The player was hit. blocked = sparks on the gloves instead of a red flash. */
  playerHit(blocked: boolean): void
  droneKO(): void
  /** Guard stamina rings by each fighter's head, 0 to 1. broken: guard break stun. Called every frame. */
  setGuardMeters?(player: GuardMeterView, bot: GuardMeterView): void
  /** Bot guard and dodge pose, with its tell. Called every frame. */
  setBotStance?(stance: BotStance): void
  /** Reset the drone and effects for a new round. */
  resetRound(): void
  /** Freeze scene animation for ms milliseconds (impact feel). */
  hitstop(ms: number): void
  /** Advance animations by real elapsed time. */
  update(dtMs: number): void
  render(): void
  /** high = bloom, pixel ratio up to 2; low = no bloom, pixel ratio 1. The scene also drops to low by itself when frames are slow. */
  readonly quality: QualityLevel
  setQuality(level: QualityLevel): void
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
  /** Edge warning plus the defence hint for that pattern while the drone charges an attack. null hides. */
  setTelegraph(pattern: AttackPattern | null): void
  setKeyboardMode(on: boolean): void
  /** Ids #again-btn and #home-btn. onHome null hides Home. */
  showRoundEnd(result: RoundResult, onAgain: () => void, onHome: (() => void) | null): void
  setDebug(values: Record<string, number | string>): void
  toggleDebug(): void
  /** count >= 2 shows the combo meter, below 2 hides it. */
  setCombo(count: number): void
  /** Round-end coach card: null shows a "coach is reviewing your round" state. */
  setCoachCard(card: CoachCard | null): void
  /** false hides the webcam preview box (keyboard-only play). */
  setCameraActive(on: boolean): void
  /** Online 1v1: name on the opponent's health bar from the next showFight. null = the drone. Optional. */
  setOpponentName?(name: string | null): void
  /** Name typed on the start screen (persisted in localStorage "motion-sports.player-name"), "" if none. */
  readonly playerName: string
  /** Remove everything the HUD added to the page and all its listeners. */
  dispose(): void
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

/** A punch this player landed on the opponent avatar in an online 1v1 (sent to the other laptop). */
export interface VersusPunch {
  id: number
  kind: PunchKind
  hand: Hand
  /** Damage if the opponent fails to block or dodge. */
  damage: number
  counter: boolean
}

/** How the other laptop defended one of our punches, and its health afterwards. */
export interface VersusDefence {
  id: number
  outcome: 'blocked' | 'dodged' | 'hit'
  damage: number
  hp: number
}

/** Online 1v1 hooks. With a link set the drone AI is off and the drone stands in for the remote player. */
export interface VersusLink {
  sendPunch(p: VersusPunch): void
  sendDefence(d: VersusDefence): void
}

export interface BoxingEngine extends SportEngine<BoxingScene> {
  readonly phase: BoxingPhase
  /** Game logic only, fixed step (main.ts runs it at 120 Hz). */
  step(dtMs: number): void
  /** Push state to the scene and advance its animation by one rendered frame. Run once per frame. */
  present(dtMs: number): void
  /** Keyboard path. Same rules as pose actions. */
  onActions(actions: BoxingActions): void
  startRound(): void
  /** Register a callback that runs once per round end. */
  onRoundEnd(cb: (result: RoundResult) => void): void
  /** Latest detector debug values plus engine values. */
  readonly debug: Record<string, number | string>
  /** Log of the last (or current) round for the coach. */
  getRoundLog(): RoundLog
  /** Stop the current round at once with no result, no callbacks and no telemetry (demo mode). */
  abortRound(): void
  /** Online 1v1: null goes back to the drone AI. */
  setVersus(link: VersusLink | null): void
  /** Online 1v1: the opponent threw a punch. It telegraphs, then strikes; this player blocks or dodges it. */
  incomingPunch(p: VersusPunch): void
  /** Online 1v1: the opponent reported how it defended one of our punches. */
  punchResolved(d: VersusDefence): void
}
