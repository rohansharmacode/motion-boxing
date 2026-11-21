// Boxing rules engine: HP, round clock, drone AI, counters and telemetry.
// Time comes only from dtMs, so a round can be replayed deterministically.
import type { BodyFrame, Calibration } from '../../pose/types.ts'
import type {
  BoxingActions,
  BoxingDetector,
  BoxingEngine,
  BoxingHud,
  BoxingPhase,
  BoxingScene,
  Punch,
  PunchCounts,
  PunchKind,
  RoundOutcome,
  RoundResult,
  SlipKind,
  Telemetry,
} from './types.ts'

const ROUND_MS = 60_000
const MAX_HP = 100
const TELEGRAPH_MS = 600
const FIRST_ATTACK_MS = 2000
const ATTACK_GAP_MIN_MS = 1400
const ATTACK_GAP_RANGE_MS = 1200
const STRIKE_DAMAGE = 12
/** Blocking cuts damage by 80 percent. */
const BLOCK_FACTOR = 0.2
const COUNTER_WINDOW_MS = 1500
const COUNTER_MULT = 1.5
const HITSTOP_MS = 40
const TICK_MS = 200
const HUD_TIMER_MS = 100
/** Longest step we simulate, so a hidden tab does not burn the round in one frame. */
const MAX_DT_MS = 250

const BASE_DAMAGE: Record<PunchKind, number> = { jab: 3, cross: 5, hook: 6, uppercut: 7 }

const round1 = (v: number): number => Math.round(v * 10) / 10

function emptyCounts(): PunchCounts {
  return { total: 0, jab: 0, cross: 0, hook: 0, uppercut: 0, landed: 0 }
}

export function createBoxingEngine(deps: {
  hud: BoxingHud
  telemetry: Telemetry
  detector: BoxingDetector
  random?: () => number
}): BoxingEngine {
  const { hud, telemetry, detector } = deps
  const random = deps.random ?? Math.random

  let scene: BoxingScene | null = null
  let calibration: Calibration | null = null
  let phase: BoxingPhase = 'idle'
  let endCallbacks: ((result: RoundResult) => void)[] = []
  let detectorDebug: Record<string, number> = {}

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

  // Defence, per source, combined into guard and slip.
  let poseGuard = false
  let poseSlip: SlipKind | null = null
  let kbGuard = false
  let kbSlip: SlipKind | null = null
  let guard = false
  let slip: SlipKind | null = null

  // Drone AI.
  let telegraphing = false
  /** Round time of the next telegraph start, or of the strike while telegraphing. */
  let nextDroneMs = FIRST_ATTACK_MS
  let telegraphStartMs = 0
  let reactionMs: number | null = null

  // Counter window opened by a slip or duck.
  let counterMs = 0
  let counterOpenedMs = 0
  let counterAnnounced = false

  const msLeft = (): number => Math.max(0, ROUND_MS - roundMs)

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
    telegraphing = false
    nextDroneMs = FIRST_ATTACK_MS
    telegraphStartMs = 0
    reactionMs = null
    counterMs = 0
    counterOpenedMs = 0
    counterAnnounced = false
    lastResult = null
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
    }
  }

  function endRound(outcome: RoundOutcome): void {
    if (phase !== 'fighting') return
    phase = 'ended'
    telegraphing = false
    counterMs = 0
    if (outcome === 'ko-win') scene?.droneKO()
    hud.setTelegraph(false)
    hud.setTimer(msLeft())
    lastResult = buildResult(outcome)
    flushTelemetry()
    const result = lastResult
    for (const cb of endCallbacks) cb(result)
  }

  function flushTelemetry(): void {
    const result = lastResult ?? buildResult('time')
    telemetry.emit({ event_type: 'TICK', metrics: { summary: true, ...result } })
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
    if (telegraphing && reactionMs === null && (guardOn || slipOn)) {
      reactionMs = Math.round(roundMs - telegraphStartMs)
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

    if (hit) {
      counts.landed++
      damage = round1(BASE_DAMAGE[punch.kind] * (0.6 + (0.4 * hit.accuracy) / 100) * (counter ? COUNTER_MULT : 1))
      droneHp = Math.max(0, round1(droneHp - damage))
      scene.droneHit(hit, damage, counter)
      scene.hitstop(HITSTOP_MS)
      hud.flashPunch(punch, true, counter)
      hud.setHp(playerHp, droneHp)
      if (counter && !counterAnnounced) {
        counterAnnounced = true
        hud.callout('COUNTER', 'info')
      }
    } else {
      hud.flashPunch(punch, false, false)
    }
    hud.setCounts({ ...counts })

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
        source: punch.source,
      },
    })

    if (droneHp <= 0) endRound('ko-win')
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
    if (phase !== 'fighting') return
    for (const punch of actions.punches) {
      if (phase !== 'fighting') break
      applyPunch(punch)
    }
  }

  function droneStrike(): void {
    telegraphing = false
    nextDroneMs = roundMs + ATTACK_GAP_MIN_MS + random() * ATTACK_GAP_RANGE_MS
    scene?.droneStrike()
    hud.setTelegraph(false)
    if (slip) {
      dodges++
      telemetry.emit({ event_type: 'DODGE', reaction_ms: reactionMs, metrics: { slip } })
      hud.callout('SLIPPED', 'good')
      counterMs = COUNTER_WINDOW_MS
      counterOpenedMs = roundMs
      counterAnnounced = false
    } else if (guard) {
      const damage = round1(STRIKE_DAMAGE * BLOCK_FACTOR)
      blocks++
      playerHp = Math.max(0, round1(playerHp - damage))
      telemetry.emit({ event_type: 'BLOCK', reaction_ms: reactionMs, metrics: { damage } })
      scene?.playerHit(true)
      hud.callout('BLOCKED', 'good')
      hud.setHp(playerHp, droneHp)
    } else {
      hitsTaken++
      playerHp = Math.max(0, round1(playerHp - STRIKE_DAMAGE))
      scene?.playerHit(false)
      scene?.hitstop(HITSTOP_MS)
      hud.callout('HIT', 'bad')
      hud.setHp(playerHp, droneHp)
    }
    if (playerHp <= 0) endRound('ko-loss')
  }

  function runDrone(): void {
    if (roundMs < nextDroneMs) return
    if (!telegraphing) {
      telegraphing = true
      telegraphStartMs = roundMs
      nextDroneMs = roundMs + TELEGRAPH_MS
      reactionMs = null
      scene?.droneTelegraph(TELEGRAPH_MS)
      hud.setTelegraph(true)
    } else {
      droneStrike()
    }
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
      telemetry.startRound()
      hud.setHp(playerHp, droneHp)
      hud.setTimer(ROUND_MS)
      hud.setCounts({ ...counts })
      hud.setTelegraph(false)
      phase = 'fighting'
    },

    onPoseFrame(body: BodyFrame | null) {
      const actions = detector.update(body)
      detectorDebug = actions.debug
      scene?.setBody(body)
      apply(actions, 'pose')
    },

    onActions(actions: BoxingActions) {
      apply(actions, 'keyboard')
    },

    update(dtMs: number) {
      const dt = Math.min(Math.max(dtMs, 0), MAX_DT_MS)
      if (phase === 'fighting') {
        roundMs += dt
        if (counterMs > 0) counterMs = Math.max(0, counterMs - dt)
        runDrone()
      }
      if (phase === 'fighting') {
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
      scene?.update(dtMs)
      hud.setGuard(guard)
    },

    flushTelemetry,

    onRoundEnd(cb: (result: RoundResult) => void) {
      endCallbacks.push(cb)
    },

    dispose() {
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
