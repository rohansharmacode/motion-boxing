// Boxing rules engine: HP, round clock, drone AI, combos, counters, KO slow motion and telemetry.
// Time comes only from dtMs, so a round can be replayed deterministically with a seeded deps.random.
import type { BodyFrame, Calibration } from '../../pose/types.ts'
import { createPosePredictor } from '../../pose/predict.ts'
import type {
  AttackPattern,
  BoxingActions,
  BoxingDetector,
  BoxingEngine,
  BoxingHud,
  BoxingPhase,
  BoxingScene,
  BoxingSfx,
  Punch,
  PunchCounts,
  PunchKind,
  RoundLog,
  RoundOutcome,
  RoundResult,
  SlipKind,
  Telemetry,
} from './types.ts'

const ROUND_MS = 60_000
const MAX_HP = 100
const TELEGRAPH_MS = 600
const FIRST_ATTACK_MS = 2000
/** Idle gap from a strike to the next telegraph: shrinks from START to END over RAMP, then holds for the last 15 s. */
const GAP_START_MS = 2600
const GAP_END_MS = 1500
const GAP_RAMP_MS = 45_000
/** Gap jitter, plus or minus 10 percent. */
const GAP_JITTER = 0.1
const PATTERNS: readonly AttackPattern[] = ['straight', 'hook', 'slam']
const STRIKE_DAMAGE: Record<AttackPattern, number> = { straight: 9, hook: 11, slam: 14 }
/** Callout when the player moved but picked the wrong defence. */
const WRONG_DODGE: Record<AttackPattern, string> = { straight: 'HIT', hook: 'DUCK THE HOOK', slam: 'SLIP THE SLAM' }
/** Blocking cuts damage by 80 percent. */
const BLOCK_FACTOR = 0.2
const COUNTER_WINDOW_MS = 1500
const COUNTER_MULT = 1.5
/** Landed punches closer than this chain into a combo. */
const COMBO_GAP_MS = 900
const COMBO_STEP = 0.1
const COMBO_MULT_MAX = 1.5
const COMBO_CALLOUTS = [3, 5, 8]
/** Real ms of slow motion between the drone KO and the round end. */
const KO_SLOWMO_MS = 1200
const KO_TIME_SCALE = 0.25
const HITSTOP_MS = 40
const TICK_MS = 200
const HUD_TIMER_MS = 100
/** Longest step we simulate, so a hidden tab does not burn the round in one frame. */
const MAX_DT_MS = 250

const BASE_DAMAGE: Record<PunchKind, number> = { jab: 3, cross: 5, hook: 6, uppercut: 7 }

interface Attack {
  pattern: AttackPattern
  /** Round ms of the telegraph start. */
  startMs: number
  /** First guard or slip after the telegraph started, ms after it. */
  reactionMs: number | null
}

const round1 = (v: number): number => Math.round(v * 10) / 10

function emptyCounts(): PunchCounts {
  return { total: 0, jab: 0, cross: 0, hook: 0, uppercut: 0, landed: 0 }
}

/** straight: any slip or duck. hook: duck only. slam: left or right slip only. */
function isDodge(pattern: AttackPattern, slip: SlipKind | null): boolean {
  if (slip === null) return false
  if (pattern === 'hook') return slip === 'duck'
  if (pattern === 'slam') return slip !== 'duck'
  return true
}

export function createBoxingEngine(deps: {
  hud: BoxingHud
  telemetry: Telemetry
  detector: BoxingDetector
  sfx?: BoxingSfx
  getPlayerName?: () => string
  random?: () => number
}): BoxingEngine {
  const { hud, telemetry, detector, sfx } = deps
  const random = deps.random ?? Math.random

  let scene: BoxingScene | null = null
  let calibration: Calibration | null = null
  let phase: BoxingPhase = 'idle'
  let endCallbacks: ((result: RoundResult) => void)[] = []
  let detectorDebug: Record<string, number> = {}
  /** Gloves are drawn ~40 ms ahead of the measured pose to hide camera and tracking lag. */
  const predictor = createPosePredictor()

  // Round state.
  let playerHp = MAX_HP
  let droneHp = MAX_HP
  let counts = emptyCounts()
  let leftPunches = 0
  let rightPunches = 0
  let blocks = 0
  let dodges = 0
  let hitsTaken = 0
  let bestSpeed = 0
  let roundMs = 0
  let tickAcc = 0
  let hudTimerAcc = 0
  let lastResult: RoundResult | null = null
  let punchLog: RoundLog['punches'] = []
  let defenceLog: RoundLog['defences'] = []
  let guardMs = 0
  /** Real ms of KO slow motion left; above 0 the fight is frozen and the round ends when it runs out. */
  let koLeftMs = 0

  // Defence, per source, combined into guard and slip.
  let poseGuard = false
  let poseSlip: SlipKind | null = null
  let kbGuard = false
  let kbSlip: SlipKind | null = null
  let guard = false
  let slip: SlipKind | null = null

  // Drone AI.
  let attack: Attack | null = null
  let nextAttackMs = FIRST_ATTACK_MS
  let lastPattern: AttackPattern | null = null
  let repeats = 0

  // Counter window opened by a dodge.
  let counterMs = 0
  let counterOpenedMs = 0
  let counterAnnounced = false

  // Combo chain of landed punches.
  let combo = 0
  let maxCombo = 0
  let lastLandedMs = 0

  const msLeft = (): number => Math.max(0, ROUND_MS - roundMs)
  /** Punches and drone attacks count only while fighting and not in the KO slow motion. */
  const live = (): boolean => phase === 'fighting' && koLeftMs === 0

  function resetRoundState(): void {
    playerHp = MAX_HP
    droneHp = MAX_HP
    counts = emptyCounts()
    leftPunches = 0
    rightPunches = 0
    blocks = 0
    dodges = 0
    hitsTaken = 0
    bestSpeed = 0
    roundMs = 0
    tickAcc = 0
    hudTimerAcc = 0
    lastResult = null
    punchLog = []
    defenceLog = []
    guardMs = 0
    koLeftMs = 0
    attack = null
    nextAttackMs = FIRST_ATTACK_MS
    lastPattern = null
    repeats = 0
    counterMs = 0
    counterOpenedMs = 0
    counterAnnounced = false
    combo = 0
    maxCombo = 0
    lastLandedMs = 0
  }

  function buildResult(outcome: RoundOutcome): RoundResult {
    return {
      outcome,
      playerHp,
      droneHp,
      counts: { ...counts },
      blocks,
      dodges,
      hitsTaken,
      bestSpeed: round1(bestSpeed),
      accuracyPct: counts.total > 0 ? Math.round((counts.landed / counts.total) * 100) : 0,
      maxCombo,
    }
  }

  function setCombo(n: number): void {
    if (n === combo) return
    combo = n
    maxCombo = Math.max(maxCombo, n)
    hud.setCombo(n)
  }

  /** Cancel any attack and counter window (KO, round end, abort). */
  function stopAction(): void {
    attack = null
    counterMs = 0
    hud.setTelegraph(null)
  }

  function endRound(outcome: RoundOutcome): void {
    if (phase !== 'fighting') return
    phase = 'ended'
    koLeftMs = 0
    stopAction()
    setCombo(0)
    if (outcome === 'time') sfx?.bell()
    else if (outcome === 'ko-loss') sfx?.ko(false)
    hud.setTimer(msLeft())
    lastResult = buildResult(outcome)
    flushTelemetry()
    const result = lastResult
    for (const cb of endCallbacks) cb(result)
  }

  /** Drone at 0 HP: slow motion for KO_SLOWMO_MS real time, then update() ends the round. */
  function startKo(): void {
    koLeftMs = KO_SLOWMO_MS
    stopAction()
    scene?.droneKO()
    scene?.setTimeScale(KO_TIME_SCALE)
    sfx?.ko(true)
  }

  function flushTelemetry(): void {
    // Nothing to summarise before a round or after an abort.
    const result = lastResult ?? (phase === 'fighting' ? buildResult(koLeftMs > 0 ? 'ko-win' : 'time') : null)
    if (!result) return
    const name = deps.getPlayerName?.().trim() ?? ''
    telemetry.emit({ event_type: 'TICK', metrics: { summary: true, ...result, ...(name ? { playerName: name } : {}) } })
  }

  /** Recompute combined defence, push it to the scene and record the first reaction to a telegraph. */
  function updateDefence(): void {
    const nextGuard = poseGuard || kbGuard
    const nextSlip = poseSlip ?? kbSlip
    const guardOn = nextGuard && !guard
    const slipOn = nextSlip !== null && nextSlip !== slip
    if (nextGuard !== guard) scene?.setGuard(nextGuard)
    if (nextSlip !== slip) scene?.setSlip(nextSlip)
    guard = nextGuard
    slip = nextSlip
    if (attack && attack.reactionMs === null && (guardOn || slipOn)) {
      attack.reactionMs = Math.round(roundMs - attack.startMs)
    }
  }

  function applyPunch(punch: Punch): void {
    if (!scene) return
    scene.punch(punch.hand, punch.kind)
    const hit = scene.resolveHit(punch.hand, punch.kind)
    const inCounter = counterMs > 0
    const landed = hit !== null
    const counter = landed && inCounter
    let damage = 0

    counts.total++
    counts[punch.kind]++
    if (punch.hand === 'left') leftPunches++
    else rightPunches++
    bestSpeed = Math.max(bestSpeed, punch.peakVelocity)
    sfx?.punch(punch.kind, landed, counter)

    if (hit) {
      setCombo(combo > 0 && roundMs - lastLandedMs < COMBO_GAP_MS ? combo + 1 : 1)
      lastLandedMs = roundMs
      counts.landed++
      const comboMult = Math.min(COMBO_MULT_MAX, 1 + COMBO_STEP * (combo - 1))
      const accuracyMult = 0.6 + (0.4 * hit.accuracy) / 100
      damage = round1(BASE_DAMAGE[punch.kind] * accuracyMult * (counter ? COUNTER_MULT : 1) * comboMult)
      droneHp = Math.max(0, round1(droneHp - damage))
      scene.droneHit(hit, damage, counter)
      scene.hitstop(HITSTOP_MS)
      hud.flashPunch(punch, true, counter)
      hud.setHp(playerHp, droneHp)
      if (COMBO_CALLOUTS.includes(combo)) hud.callout(`${combo} HIT COMBO`, 'good')
      else if (counter && !counterAnnounced) hud.callout('COUNTER', 'info')
      if (counter) counterAnnounced = true
      if (combo >= 3) sfx?.combo(combo)
    } else {
      setCombo(0)
      hud.flashPunch(punch, false, false)
    }
    hud.setCounts({ ...counts })
    punchLog.push({
      kind: punch.kind,
      hand: punch.hand,
      t: Math.round(roundMs),
      speed: round1(punch.peakVelocity),
      landed,
      counter,
      combo,
    })

    const maxHand = Math.max(leftPunches, rightPunches)
    telemetry.emit({
      event_type: 'PUNCH',
      peak_velocity: round1(punch.peakVelocity),
      accuracy_score: hit ? Math.round(hit.accuracy) : 0,
      symmetry_ratio: maxHand > 0 ? Math.round((Math.min(leftPunches, rightPunches) / maxHand) * 100) / 100 : null,
      reaction_ms: inCounter ? Math.round(roundMs - counterOpenedMs) : null,
      metrics: {
        punchType: punch.kind,
        hand: punch.hand,
        elbowAngle: Math.round(punch.elbowAngle),
        landed,
        target: hit ? hit.target : null,
        damage,
        counter,
        combo,
        source: punch.source,
      },
    })

    if (droneHp <= 0) startKo()
  }

  function apply(actions: BoxingActions, source: 'pose' | 'keyboard'): void {
    if (source === 'pose') {
      poseGuard = actions.guard
      poseSlip = actions.slip
    } else {
      kbGuard = actions.guard
      kbSlip = actions.slip
    }
    updateDefence()
    for (const punch of actions.punches) {
      if (!live()) break
      applyPunch(punch)
    }
  }

  /** Seeded pick that never repeats one pattern 3 times in a row. */
  function pickPattern(): AttackPattern {
    const options = repeats >= 2 ? PATTERNS.filter((p) => p !== lastPattern) : PATTERNS
    const pattern = options[Math.min(options.length - 1, Math.floor(random() * options.length))]
    repeats = pattern === lastPattern ? repeats + 1 : 1
    lastPattern = pattern
    return pattern
  }

  function attackGapMs(): number {
    const k = Math.min(1, roundMs / GAP_RAMP_MS)
    const base = GAP_START_MS + (GAP_END_MS - GAP_START_MS) * k
    return base * (1 - GAP_JITTER + 2 * GAP_JITTER * random())
  }

  function telegraph(): void {
    const pattern = pickPattern()
    attack = { pattern, startMs: roundMs, reactionMs: null }
    scene?.droneTelegraph(TELEGRAPH_MS, pattern)
    hud.setTelegraph(pattern)
    sfx?.telegraph(pattern)
  }

  function strike(a: Attack): void {
    // Clear first so this attack can never resolve (or deal damage) twice.
    attack = null
    nextAttackMs = roundMs + attackGapMs()
    scene?.droneStrike(a.pattern)
    hud.setTelegraph(null)
    let outcome: RoundLog['defences'][number]['outcome']
    if (isDodge(a.pattern, slip)) {
      outcome = 'dodged'
      dodges++
      telemetry.emit({ event_type: 'DODGE', reaction_ms: a.reactionMs, metrics: { pattern: a.pattern, slip } })
      hud.callout(slip === 'duck' ? 'DUCKED' : 'SLIPPED', 'good')
      sfx?.dodge()
      counterMs = COUNTER_WINDOW_MS
      counterOpenedMs = roundMs
      counterAnnounced = false
    } else if (guard) {
      outcome = 'blocked'
      const damage = round1(STRIKE_DAMAGE[a.pattern] * BLOCK_FACTOR)
      blocks++
      playerHp = Math.max(0, round1(playerHp - damage))
      telemetry.emit({ event_type: 'BLOCK', reaction_ms: a.reactionMs, metrics: { pattern: a.pattern, damage } })
      scene?.playerHit(true)
      hud.callout('BLOCKED', 'good')
      sfx?.block()
    } else {
      outcome = 'hit'
      hitsTaken++
      playerHp = Math.max(0, round1(playerHp - STRIKE_DAMAGE[a.pattern]))
      scene?.playerHit(false)
      scene?.hitstop(HITSTOP_MS)
      hud.callout(slip ? WRONG_DODGE[a.pattern] : 'HIT', 'bad')
      sfx?.playerHit()
      setCombo(0)
    }
    hud.setHp(playerHp, droneHp)
    defenceLog.push({ pattern: a.pattern, t: Math.round(roundMs), outcome, reactionMs: a.reactionMs })
    if (playerHp <= 0) endRound('ko-loss')
  }

  function runDrone(): void {
    if (attack) {
      if (roundMs >= attack.startMs + TELEGRAPH_MS) strike(attack)
    } else if (roundMs >= nextAttackMs && roundMs + TELEGRAPH_MS <= ROUND_MS) {
      telegraph()
    }
  }

  /** One fighting step of dt ms. */
  function fight(dt: number): void {
    roundMs += dt
    if (guard) guardMs += dt
    if (counterMs > 0) counterMs = Math.max(0, counterMs - dt)
    if (combo > 0 && roundMs - lastLandedMs >= COMBO_GAP_MS) setCombo(0)
    runDrone()
    if (phase !== 'fighting') return
    tickAcc += dt
    if (tickAcc >= TICK_MS) {
      tickAcc %= TICK_MS
      telemetry.emit({
        event_type: 'TICK',
        metrics: { guard, slip, playerHp, droneHp, msLeft: Math.round(msLeft()) },
      })
    }
    hudTimerAcc += dt
    if (hudTimerAcc >= HUD_TIMER_MS) {
      hudTimerAcc %= HUD_TIMER_MS
      hud.setTimer(msLeft())
    }
    if (roundMs >= ROUND_MS) endRound('time')
  }

  const engine: BoxingEngine = {
    get phase() {
      return phase
    },

    get debug() {
      return {
        ...detectorDebug,
        phase,
        playerHp,
        droneHp,
        msLeft: Math.round(msLeft()),
        counterMs: Math.round(counterMs),
        combo,
        attack: attack ? attack.pattern : '-',
        shoulderWidth: calibration ? round1(calibration.shoulderWidth * 100) / 100 : 0,
      }
    },

    init(s: BoxingScene, c: Calibration) {
      scene = s
      calibration = c
      phase = 'idle'
    },

    startRound() {
      resetRoundState()
      scene?.resetRound()
      scene?.setTimeScale(1)
      telemetry.startRound()
      hud.setHp(playerHp, droneHp)
      hud.setTimer(ROUND_MS)
      hud.setCounts({ ...counts })
      hud.setTelegraph(null)
      hud.setCombo(0)
      sfx?.bell()
      phase = 'fighting'
    },

    onPoseFrame(body: BodyFrame | null) {
      const actions = detector.update(body)
      detectorDebug = actions.debug
      scene?.setBody(predictor.push(body))
      apply(actions, 'pose')
    },

    onActions(actions: BoxingActions) {
      apply(actions, 'keyboard')
    },

    update(dtMs: number) {
      const dt = Math.min(Math.max(dtMs, 0), MAX_DT_MS)
      if (phase === 'fighting' && koLeftMs > 0) {
        koLeftMs = Math.max(0, koLeftMs - dt)
        if (koLeftMs === 0) {
          scene?.setTimeScale(1)
          endRound('ko-win')
        }
      } else if (phase === 'fighting') {
        fight(dt)
      }
      scene?.update(dtMs)
      hud.setGuard(guard)
    },

    flushTelemetry,

    onRoundEnd(cb: (result: RoundResult) => void) {
      endCallbacks.push(cb)
    },

    getRoundLog(): RoundLog {
      return {
        roundMs: Math.round(roundMs),
        punches: punchLog.map((p) => ({ ...p })),
        defences: defenceLog.map((d) => ({ ...d })),
        guardMs: Math.round(guardMs),
      }
    },

    abortRound() {
      scene?.setTimeScale(1)
      koLeftMs = 0
      phase = 'idle'
      lastResult = null
      stopAction()
      setCombo(0)
    },

    dispose() {
      if (koLeftMs > 0) scene?.setTimeScale(1)
      endCallbacks = []
      resetRoundState()
      detectorDebug = {}
      poseGuard = false
      poseSlip = null
      kbGuard = false
      kbSlip = null
      guard = false
      slip = null
      scene = null
      calibration = null
      phase = 'idle'
    },
  }

  return engine
}
