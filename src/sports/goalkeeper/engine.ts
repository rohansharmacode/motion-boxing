// Reflex Keeper engine: striker state machine, fixed-step ball physics, swept glove/torso saves,
// reaction and velocity metrics, and MOTION_EVENTS telemetry. Research doc section 3 (Sport 2).
// All time is driven by update(dtMs); no timers.

import { DIFFICULTY_PARAMS, rampSteps, rampedSpeed } from './difficulty.ts'
import { planPracticeShot, planShot, tellAt } from './shots.ts'
import { gradeSave, kickPoints, nextCombo, resultGrade, scoreKicks } from './grading.ts'
import { bestReaction, dailyKey, dailySeed, planDailyRound, roundOver, suddenGrade } from './modes.ts'
import type { RoundMode } from './modes.ts'
import type { ShotPlan } from './shots.ts'
import type { Difficulty } from './difficulty.ts'
import { OneEuroVec3 } from './filter.ts'
import { keeperPoseFromBody, pointerPoseInto } from './mapping.ts'
import {
  BALL_RADIUS,
  GLOVE_RADIUS,
  GOAL_Z,
  PENALTY_Z,
  PHYS_DT,
  TORSO_RADIUS,
  inGoalMouth,
  resolveSave,
  solveLaunch,
  stepBall,
  sweptCapsuleHit,
  sweptSphereHit,
} from './physics.ts'
import {
  IDLE_MS,
  KICK_MS,
  RECOVER_MS,
  RESULT_MS,
  RUNUP_MS,
  TELEGRAPH_MS,
} from './striker.ts'
import { createKeeperTelemetry } from './telemetry.ts'
import {
  type BallState,
  type BodyFrame,
  type Calibration,
  type KeeperEngine,
  type KeeperPart,
  type KeeperPhase,
  type KeeperPose,
  type KeeperScene,
  type KeeperTelemetry,
  type KickResult,
  type ShootoutResult,
  type StrikerPhase,
  type StrikerTell,
  type SweptHit,
  type Vec3,
  type Zone,
} from './types.ts'

/** Internal per-kick stage. 'result' shows the striker in 'recover'. */
type Stage = StrikerPhase | 'result'

const MAX_DT_MS = 100
const MAX_SUBSTEPS = 8
/** No body for this long: hand the scene a null pose (gloves ease to ready). */
const UNTRACKED_GRACE_MS = 400
/** Glove speed (m/s) that counts as a decisive reaction. */
const REACTION_SPEED = 1.8
/** Faster than this after the telegraph starts is anticipation, not reaction, ms. */
const MIN_REACTION_MS = 100
/** Mouse-mode glove speed cap, m/s (a fast human hand). */
const MAX_POINTER_SPEED = 8
/** Game-world speed during the save/goal slow-mo, and how long it lasts in real ms. */
const SLOWMO_SCALE = 0.3
const SLOWMO_SAVE_MS = 700
const SLOWMO_GOAL_MS = 550
/** Glove speed (m/s) toward the ball for a punch clearance. */
const PUNCH_SPEED = 2.5
const TICK_MS = 200
const AUTO_FLUSH_MS = 2500
/** Velocity EMA weight per new sample. */
const VEL_EMA = 0.5
/** Untracked velocity decay time constant, ms. */
const VEL_DECAY_MS = 150
/** Collision window around the keeper plane (ball centre z). */
const COLLIDE_Z_MIN = GOAL_Z - 1.0
const COLLIDE_Z_MAX = GOAL_Z + 0.3
/** Failsafe: resolve as off target if the ball has not crossed this long after the planned flight. */
const FLIGHT_TIMEOUT_S = 1.5
/** Goal: ball settles inside the net no deeper than this. */
const NET_DEPTH_Z = 1.2

const NEUTRAL_TELL: StrikerTell = { side: 0, high: false }

function v3(): Vec3 {
  return { x: 0, y: 0, z: 0 }
}
function set3(dst: Vec3, x: number, y: number, z: number): void {
  dst.x = x
  dst.y = y
  dst.z = z
}
function cp(dst: Vec3, src: Vec3): void {
  dst.x = src.x
  dst.y = src.y
  dst.z = src.z
}
function lerpInto(dst: Vec3, a: Vec3, b: Vec3, t: number): void {
  dst.x = a.x + (b.x - a.x) * t
  dst.y = a.y + (b.y - a.y) * t
  dst.z = a.z + (b.z - a.z) * t
}
function len(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
}
function dist(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}
function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}
const GLOVE_PARTS = ['left', 'right'] as const
/** World freeze on a glove/body save, real ms (impact feel before the slow-mo). */
export const HITSTOP_MS = 80

/** Copy of a precomputed daily shot so per-kick edits (tell.kind) never touch the stored plan. */
function cloneShot(s: ShotPlan): ShotPlan {
  return {
    ...s,
    target: { ...s.target },
    omega: { ...s.omega },
    tell: { ...s.tell },
    fake: s.fake ? { ...s.fake } : null,
  }
}

function scaleInto(v: Vec3, k: number): void {
  v.x *= k
  v.y *= k
  v.z *= k
}

/** Clamp a velocity's length to max, in place. */
function capSpeed(v: Vec3, max: number): void {
  const l = len(v)
  if (l > max) scaleInto(v, max / l)
}

function makePose(): KeeperPose {
  return { left: v3(), right: v3(), torsoTop: v3(), torsoBottom: v3(), tracked: false }
}
function copyPose(dst: KeeperPose, src: KeeperPose): void {
  cp(dst.left, src.left)
  cp(dst.right, src.right)
  cp(dst.torsoTop, src.torsoTop)
  cp(dst.torsoBottom, src.torsoBottom)
  dst.tracked = src.tracked
}
function closestOnSegmentInto(dst: Vec3, p: Vec3, a: Vec3, b: Vec3): void {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const abz = b.z - a.z
  const l2 = abx * abx + aby * aby + abz * abz
  let u = l2 < 1e-12 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / l2
  u = clamp(u, 0, 1)
  set3(dst, a.x + abx * u, a.y + aby * u, a.z + abz * u)
}

/** Per-part velocity set (m/s). */
interface PartVel {
  left: Vec3
  right: Vec3
  torso: Vec3
}
function makeVel(): PartVel {
  return { left: v3(), right: v3(), torso: v3() }
}
function zeroVel(v: PartVel): void {
  set3(v.left, 0, 0, 0)
  set3(v.right, 0, 0, 0)
  set3(v.torso, 0, 0, 0)
}
function emaInto(dst: Vec3, cur: Vec3, prev: Vec3, dtS: number): void {
  dst.x += VEL_EMA * ((cur.x - prev.x) / dtS - dst.x)
  dst.y += VEL_EMA * ((cur.y - prev.y) / dtS - dst.y)
  dst.z += VEL_EMA * ((cur.z - prev.z) / dtS - dst.z)
}

export function createKeeperEngine(opts?: {
  rng?: () => number
  telemetry?: KeeperTelemetry
}): KeeperEngine {
  const rng = opts?.rng ?? Math.random
  const telemetry = opts?.telemetry ?? createKeeperTelemetry()

  let scene: KeeperScene | null = null
  let swMetres = 0.4
  let disposed = false

  // ---- callbacks ----
  let kickCbs: ((r: KickResult) => void)[] = []
  let strikerCbs: ((phase: StrikerPhase, kick: number) => void)[] = []
  let endCbs: ((r: ShootoutResult) => void)[] = []

  // ---- engine clock & phase ----
  let clock = 0 // ms of update-driven time
  let phase: KeeperPhase = 'idle'
  let results: KickResult[] = []
  let kick = 0
  let stage: Stage = 'idle'
  let stageMs = 0
  let lastSceneStriker: StrikerPhase | null = null
  let plan: ShotPlan | null = null
  let telegraphStart = -1
  let leftSaves = 0
  let rightSaves = 0
  let difficulty: Difficulty = 'normal'
  let practice = false
  let mode: RoundMode = 'classic'
  let dailyPlans: ShotPlan[] = []
  let dailyDate = ''
  /** Extra wait before the first kick so the kickoff countdown can play. */
  let firstIdleMs = 0
  /** Real ms left of the save hit-stop (world frozen). */
  let hitStopLeft = 0
  /** Real saves this round (glove or body), for the auto-ramp. */
  let roundSaves = 0
  let combo = 0

  // ---- body pose ----
  // Doc tuning: minCutoff 1.2 Hz, beta 0.12. Poses here are in metres, where a 5 m/s lunge would raise the
  // cutoff by only 0.6 Hz (~130 ms lag). Treat beta as per cm/s (x100) so fast reaches pass with little lag.
  const BETA_PER_M = 0.12 * 100
  const filters = {
    left: new OneEuroVec3(1.2, BETA_PER_M),
    right: new OneEuroVec3(1.2, BETA_PER_M),
    torsoTop: new OneEuroVec3(1.2, BETA_PER_M),
    torsoBottom: new OneEuroVec3(1.2, BETA_PER_M),
  }
  const bodyPose = makePose()
  const bodyPrev = makePose()
  let hasBodyPose = false
  let bodyT = -1 // ms (BodyFrame.t) of the last filtered sample
  let bodyTracked = false
  let untrackedSinceClock = 0
  const bodyVel = makeVel()

  // ---- pointer ----
  let pointerActive = false
  const pointerCur = makePose()
  const pointerLast = makePose() // at the previous update
  let pointerHasLast = false
  const pointerVel = makeVel()

  // ---- collision interpolation (active pose at the end of the previous update) ----
  const prevLeft = v3()
  const prevRight = v3()
  let prevValid = false
  const c0 = v3()
  const c1 = v3()
  const tmp = v3()
  const centreAt = v3()

  // ---- ball ----
  const ball: BallState = { p: v3(), v: v3(), omega: v3() }
  const ballPrev = v3()
  let ballVisible = false
  let ballLaunched = false
  let resolved = false
  let resolvedOutcome: 'save' | 'goal' | null = null
  let flightS = 0
  let launchSpeed = 0
  let launchSpin = 0
  let physAcc = 0

  // ---- per-kick metrics ----
  let reactionMs: number | null = null
  let reactionArmed = false

  // ---- slow-mo (real ms) ----
  let slowMoLeft = 0
  let slowMoTotal = 1
  let timeScale = 1
  /** Holds SLOWMO_SCALE, then eases back to 1 over the last 40% of the window. */
  function slowMoScale(): number {
    if (slowMoLeft <= 0) return 1
    const u = slowMoLeft / slowMoTotal // 1 at the start, 0 at the end
    if (u > 0.4) return SLOWMO_SCALE
    const k = u / 0.4
    return SLOWMO_SCALE + (1 - SLOWMO_SCALE) * (1 - k * k)
  }
  let peakMs = 0 // m/s
  let lastGloveSpeed = 0 // m/s, max of both gloves, current

  // ---- telemetry clocks ----
  let tickAcc = 0
  let flushAcc = 0

  function activePose(): KeeperPose | null {
    if (pointerActive) return pointerCur
    if (!hasBodyPose) return null
    if (!bodyTracked && clock - untrackedSinceClock > UNTRACKED_GRACE_MS) return null
    return bodyPose
  }
  function activeVel(): PartVel {
    return pointerActive ? pointerVel : bodyVel
  }
  function source(): 'mouse' | 'pose' {
    return pointerActive ? 'mouse' : 'pose'
  }

  function sceneStriker(): StrikerPhase {
    return stage === 'result' ? 'recover' : stage
  }

  function stageDuration(s: Stage): number {
    switch (s) {
      case 'idle':
        return kick === 0 ? Math.max(IDLE_MS, firstIdleMs) : IDLE_MS
      case 'runup':
        return RUNUP_MS
      case 'telegraph':
        return TELEGRAPH_MS
      case 'kick':
        return KICK_MS
      case 'recover':
        return RECOVER_MS
      case 'result':
        return RESULT_MS
    }
  }

  function restBall(): void {
    set3(ball.p, 0, BALL_RADIUS, PENALTY_Z)
    set3(ball.v, 0, 0, 0)
    set3(ball.omega, 0, 0, 0)
  }

  function beginKick(n: number): void {
    kick = n
    stage = 'idle'
    stageMs = 0
    plan = practice
      ? planPracticeShot(n)
      : mode === 'daily'
        ? cloneShot(dailyPlans[Math.min(n, dailyPlans.length - 1)])
        : planShot(
          n,
          rng,
          results.map((r) => r.zone),
          DIFFICULTY_PARAMS[difficulty],
          rampedSpeed(difficulty, roundSaves),
        )
    plan.tell.kind = plan.shot
    if (plan.fake) plan.fake.kind = plan.shot
    telegraphStart = -1
    ballLaunched = false
    resolved = false
    resolvedOutcome = null
    flightS = 0
    launchSpeed = 0
    launchSpin = 0
    physAcc = 0
    reactionMs = null
    reactionArmed = false
    peakMs = 0
    restBall()
    ballVisible = true
    scene?.highlightZone(null, 'info')
  }

  function launch(): void {
    if (!plan) return
    restBall()
    const v = solveLaunch(ball.p, plan.target, plan.flightTime, plan.omega)
    cp(ball.v, v)
    cp(ball.omega, plan.omega)
    launchSpeed = len(ball.v)
    launchSpin = len(ball.omega)
    ballLaunched = true
    flightS = 0
    physAcc = 0
  }

  function symmetry(): number | null {
    const mx = Math.max(leftSaves, rightSaves)
    if (mx === 0) return null
    return Math.min(leftSaves, rightSaves) / mx
  }

  function resolveKick(
    outcome: 'save' | 'goal',
    part: KeeperPart | null,
    accuracy: number,
    punch: boolean,
    offTarget: boolean,
  ): void {
    if (!plan) return
    resolved = true
    resolvedOutcome = outcome
    if (part === 'left') leftSaves++
    else if (part === 'right') rightSaves++
    const result: KickResult = {
      kick,
      outcome,
      zone: plan.zone,
      part,
      reactionMs,
      peakVelocity: peakMs / swMetres,
      accuracy: clamp(accuracy, 0, 100),
      punch,
      ballSpeed: launchSpeed,
      difficulty,
      rampStep: rampSteps(roundSaves),
      shot: plan.shot,
      fake: plan.fake !== null,
    }
    if (outcome === 'save' && part !== null) roundSaves++
    const grade = gradeSave({ outcome, part, accuracy: result.accuracy, reactionMs })
    combo = nextCombo(combo, grade)
    result.grade = grade
    result.combo = combo
    result.points = kickPoints(grade, combo, punch)
    results.push(result)
    stage = 'result'
    stageMs = 0
    slowMoTotal = slowMoLeft = outcome === 'save' ? SLOWMO_SAVE_MS : SLOWMO_GOAL_MS
    if (outcome === 'save' && part !== null) hitStopLeft = HITSTOP_MS
    for (const cb of kickCbs) cb(result)
    if (practice) return // practice never reaches the server or the leaderboard
    telemetry.emit({
      event_type: outcome === 'save' ? 'SAVE' : 'GOAL',
      peak_velocity: result.peakVelocity,
      reaction_ms: reactionMs,
      accuracy_score: result.accuracy,
      symmetry_ratio: symmetry(),
      metrics: {
        kick,
        zone: plan.zone,
        row: Math.floor(plan.zone / 3),
        col: plan.zone % 3,
        part,
        punch,
        ballSpeed: round3(launchSpeed),
        spin: round3(launchSpin),
        flightTime: round3(plan.flightTime),
        offTarget,
        source: source(),
        mode,
        difficulty,
        saveGrade: grade,
        combo,
        points: result.points,
        shot: plan.shot,
        fake: plan.fake !== null,
        rampStep: result.rampStep,
      },
    })
  }

  function endShootout(): void {
    phase = 'ended'
    ballVisible = false
    stage = 'idle'
    stageMs = 0
    plan = null
    let saves = 0
    let goals = 0
    let reactSum = 0
    let reactN = 0
    let best = 0
    for (const r of results) {
      if (r.reactionMs !== null) {
        reactSum += r.reactionMs
        reactN++
      }
      if (r.peakVelocity > best) best = r.peakVelocity
      if (r.outcome === 'save') saves++
      else goals++
    }
    const scored = scoreKicks(results.map((r) => ({ grade: r.grade ?? null, punch: r.punch })))
    const score = scored.score
    const summary: ShootoutResult = {
      kicks: results.slice(),
      saves,
      goals,
      avgReactionMs: reactN > 0 ? reactSum / reactN : null,
      bestPeakVelocity: best,
      score,
      difficulty,
      grade: resultGrade(saves, results.length, score),
      bestCombo: scored.bestCombo,
      savePct: results.length > 0 ? Math.round((saves / results.length) * 100) : 0,
      perfects: scored.perfects,
    }
    summary.mode = mode
    summary.bestReactionMs = bestReaction(results)
    if (mode === 'sudden') summary.grade = suddenGrade(saves)
    if (mode === 'daily') summary.dailyKey = dailyDate
    if (practice) {
      summary.practice = true
      for (const cb of endCbs) cb(summary)
      return
    }
    telemetry.flush()
    flushAcc = 0
    // Round summary for the shell dashboard's personal bests (src/shell/records.ts reads TICK +
    // metrics.summary). counts.total feeds its "best" counter, so for the keeper it is saves.
    const total = results.length
    telemetry.emit({
      event_type: 'TICK',
      peak_velocity: best,
      reaction_ms: summary.avgReactionMs,
      accuracy_score: total > 0 ? (saves / total) * 100 : 0,
      symmetry_ratio: symmetry(),
      metrics: {
        summary: true,
        outcome: saves > goals ? 'win' : 'loss',
        counts: { total: saves, saves, goals, kicks: total },
        accuracyPct: total > 0 ? Math.round((saves / total) * 100) : 0,
        bestSpeed: best,
        score: summary.score,
        avgReactionMs: summary.avgReactionMs,
        bestReactionMs: summary.bestReactionMs,
        mode,
        difficulty,
        grade: summary.grade,
        bestCombo: summary.bestCombo,
        perfects: summary.perfects,
        source: source(),
      },
    })
    for (const cb of endCbs) cb(summary)
  }

  // ---- collision ----

  function testCollisions(pose: KeeperPose, f0: number, f1: number): void {
    if (!plan) return
    const curZ = ball.p.z
    if (Math.max(ballPrev.z, curZ) < COLLIDE_Z_MIN || Math.min(ballPrev.z, curZ) > COLLIDE_Z_MAX) return

    let bestHit: SweptHit | null = null
    let bestPart: KeeperPart | null = null
    let bestRadius = 0


    // Gloves: centre interpolated from the previous update's pose to the current one across substeps.
    for (const part of GLOVE_PARTS) {
      const cur = pose[part]
      const prev = prevValid ? (part === 'left' ? prevLeft : prevRight) : cur
      lerpInto(c0, prev, cur, f0)
      lerpInto(c1, prev, cur, f1)
      const hit = sweptSphereHit(ballPrev, ball.p, BALL_RADIUS, c0, c1, GLOVE_RADIUS)
      if (hit && (!bestHit || hit.t < bestHit.t)) {
        bestHit = hit
        bestPart = part
        bestRadius = GLOVE_RADIUS
        lerpInto(centreAt, c0, c1, hit.t)
      }
    }
    const torsoHit = sweptCapsuleHit(ballPrev, ball.p, BALL_RADIUS, pose.torsoTop, pose.torsoBottom, TORSO_RADIUS)
    if (torsoHit && (!bestHit || torsoHit.t < bestHit.t)) {
      bestHit = torsoHit
      bestPart = 'torso'
      bestRadius = TORSO_RADIUS
      closestOnSegmentInto(centreAt, torsoHit.point, pose.torsoTop, pose.torsoBottom)
    }
    if (!bestHit || !bestPart) return

    const vels = activeVel()
    const colliderVel = bestPart === 'torso' ? vels.torso : vels[bestPart]
    // Ball direction before the save, for the punch test.
    const bs = len(ball.v)
    let punch = false
    if (bestPart !== 'torso') {
      const towardBall = bs > 1e-6 ? -(colliderVel.x * ball.v.x + colliderVel.y * ball.v.y + colliderVel.z * ball.v.z) / bs : 0
      punch = -colliderVel.z >= PUNCH_SPEED || towardBall >= PUNCH_SPEED
    }
    // Centredness: at first contact the centre distance is always ~R, so measure the perpendicular
    // offset of the collider centre from the ball's line of travel (relative to the collider).
    set3(tmp, ball.v.x - colliderVel.x, ball.v.y - colliderVel.y, ball.v.z - colliderVel.z)
    const rl = len(tmp)
    let offset = dist(bestHit.point, centreAt)
    if (rl > 1e-6) {
      const dx = centreAt.x - bestHit.point.x
      const dy = centreAt.y - bestHit.point.y
      const dz = centreAt.z - bestHit.point.z
      const ux = tmp.x / rl
      const uy = tmp.y / rl
      const uz = tmp.z / rl
      const cx = dy * uz - dz * uy
      const cy = dz * ux - dx * uz
      const cz = dx * uy - dy * ux
      offset = Math.sqrt(cx * cx + cy * cy + cz * cz)
    }
    const accuracy = 100 * (1 - offset / (BALL_RADIUS + bestRadius))
    resolveSave(ball, bestHit, colliderVel)
    const strength = clamp(launchSpeed / 30 + (punch ? 0.35 : 0), 0.3, 1)
    scene?.flashSave(bestHit.point, bestPart, strength)
    scene?.shake(punch ? 0.45 : 0.25)
    scene?.highlightZone(plan.zone, 'save')
    resolveKick('save', bestPart, accuracy, punch, false)
  }

  function checkGoalLine(pose: KeeperPose | null): void {
    if (!plan) return
    if (!(ballPrev.z < GOAL_Z && ball.p.z >= GOAL_Z)) return
    const f = (GOAL_Z - ballPrev.z) / (ball.p.z - ballPrev.z)
    lerpInto(tmp, ballPrev, ball.p, f)
    if (inGoalMouth(tmp.x, tmp.y)) {
      let nearest = Infinity
      if (pose) nearest = Math.min(dist(tmp, pose.left), dist(tmp, pose.right))
      const accuracy = Number.isFinite(nearest) ? 100 * Math.max(0, 1 - nearest / 2.0) : 0
      const point = { x: tmp.x, y: tmp.y, z: tmp.z }
      scene?.flashGoal(point)
      scene?.shake(0.5)
      scene?.highlightZone(plan.zone, 'goal')
      resolveKick('goal', null, accuracy, false, false)
    } else {
      // Wide or over: the keeper keeps a clean sheet but it is flagged off target.
      scene?.highlightZone(plan.zone, 'info')
      resolveKick('save', null, 0, false, true)
    }
  }

  function substep(f0: number, f1: number): void {
    cp(ballPrev, ball.p)
    stepBall(ball, PHYS_DT)
    flightS += PHYS_DT
    // Ground bounce.
    if (ball.p.y < BALL_RADIUS) {
      ball.p.y = BALL_RADIUS
      if (ball.v.y < 0) ball.v.y = -0.5 * ball.v.y
      ball.v.x *= 0.9
      ball.v.z *= 0.9
    }
    if (!resolved) {
      const pose = activePose()
      if (pose) testCollisions(pose, f0, f1)
      if (!resolved) checkGoalLine(pose)
      if (!resolved && flightS > (plan?.flightTime ?? 1) + FLIGHT_TIMEOUT_S) {
        resolveKick('save', null, 0, false, true)
      }
    } else if (resolvedOutcome === 'goal') {
      // Settle into the net.
      if (ball.p.z > NET_DEPTH_Z) {
        ball.p.z = NET_DEPTH_Z
        if (ball.v.z > 0) ball.v.z = -0.15 * ball.v.z
      }
      const damp = Math.pow(0.04, PHYS_DT) // strong drag in the net
      ball.v.x *= damp
      ball.v.z *= damp
      ball.omega.x *= damp
      ball.omega.y *= damp
      ball.omega.z *= damp
    }
  }

  function runPhysics(dtS: number): void {
    if (!ballLaunched) return
    physAcc += dtS
    let n = Math.floor(physAcc / PHYS_DT)
    if (n > MAX_SUBSTEPS) {
      n = MAX_SUBSTEPS
      physAcc = n * PHYS_DT
    }
    for (let i = 0; i < n; i++) {
      substep(i / n, (i + 1) / n)
      physAcc -= PHYS_DT
    }
  }

  // ---- velocity / metrics ----

  function updatePointerVel(dtS: number): void {
    if (!pointerActive) return
    if (pointerHasLast && dtS > 0) {
      emaInto(pointerVel.left, pointerCur.left, pointerLast.left, dtS)
      emaInto(pointerVel.right, pointerCur.right, pointerLast.right, dtS)
      emaInto(pointerVel.torso, pointerCur.torsoTop, pointerLast.torsoTop, dtS)
      // A mouse can jump metres in one frame; cap at a fast human hand so mouse play can't post
      // impossible glove speeds (which also feed the dashboard's best speed).
      capSpeed(pointerVel.left, MAX_POINTER_SPEED)
      capSpeed(pointerVel.right, MAX_POINTER_SPEED)
      capSpeed(pointerVel.torso, MAX_POINTER_SPEED)
    }
    copyPose(pointerLast, pointerCur)
    pointerHasLast = true
  }

  function updateMetrics(): void {
    const vels = activeVel()
    const pose = activePose()
    const ls = pose ? len(vels.left) : 0
    const rs = pose ? len(vels.right) : 0
    lastGloveSpeed = Math.max(ls, rs)
    if (phase !== 'playing' || !plan || resolved || telegraphStart < 0) return
    if (lastGloveSpeed > peakMs) peakMs = lastGloveSpeed
    // A glove already moving at the telegraph is not a reaction: wait until it has been below the
    // threshold once, and ignore anything faster than human reaction time (anticipation).
    if (lastGloveSpeed <= REACTION_SPEED) reactionArmed = true
    if (reactionMs === null && reactionArmed && lastGloveSpeed > REACTION_SPEED && clock - telegraphStart >= MIN_REACTION_MS) {
      const tx = plan.target.x
      const side = tx < -0.6 ? -1 : tx > 0.6 ? 1 : 0
      const ok =
        side === 0 ||
        (ls > REACTION_SPEED && vels.left.x * side > 0) ||
        (rs > REACTION_SPEED && vels.right.x * side > 0)
      if (ok) reactionMs = Math.round(clock - telegraphStart)
    }
  }

  // ---- striker state machine ----

  function advanceStage(dtMs: number): void {
    if (phase !== 'playing') return
    stageMs += dtMs
    // Loop so a long dt can pass short stages; recover only ends on resolution.
    for (let guard = 0; guard < 8; guard++) {
      if (stage === 'recover') {
        // Ends when the kick resolves (resolveKick switches to 'result').
        break
      }
      const d = stageDuration(stage)
      if (stageMs < d) break
      stageMs -= d
      if (stage === 'idle') stage = 'runup'
      else if (stage === 'runup') {
        stage = 'telegraph'
        telegraphStart = clock - stageMs
      } else if (stage === 'telegraph') {
        stage = 'kick'
        launch()
      } else if (stage === 'kick') {
        stage = resolved ? 'result' : 'recover'
      } else if (stage === 'result') {
        ballVisible = false
        if (roundOver(mode, results)) {
          endShootout()
          return
        }
        beginKick(kick + 1)
        stageMs = 0
      }
    }
  }

  function strikerProgress(): number {
    if (phase !== 'playing') return 0
    if (stage === 'recover') return plan ? clamp(flightS / Math.max(plan.flightTime, 0.05), 0, 1) : 0
    if (stage === 'result') return 1
    return clamp(stageMs / stageDuration(stage), 0, 1)
  }

  function pushScene(): void {
    if (!scene) return
    const sp: StrikerPhase = phase === 'playing' ? sceneStriker() : 'idle'
    const tell = plan && phase === 'playing' ? (sp === 'telegraph' ? tellAt(plan, strikerProgress()) : plan.tell) : NEUTRAL_TELL
    scene.setStriker(sp, strikerProgress(), tell)
    if (sp !== lastSceneStriker) {
      lastSceneStriker = sp
      if (phase === 'playing') for (const cb of strikerCbs) cb(sp, kick)
    }
    scene.setKeeper(activePose())
    scene.setBall(ball.p, ball.omega, ballVisible && phase === 'playing')
  }

  function queueTickIfDue(dtMs: number): void {
    if (phase !== 'playing' || practice) return
    tickAcc += dtMs
    while (tickAcc >= TICK_MS) {
      tickAcc -= TICK_MS
      const pose = activePose()
      telemetry.queueTick({
        peak_velocity: lastGloveSpeed / swMetres,
        metrics: {
          kick,
          phase: stage,
          tracked: pointerActive ? false : bodyTracked,
          leftX: pose ? round3(pose.left.x) : null,
          leftY: pose ? round3(pose.left.y) : null,
          rightX: pose ? round3(pose.right.x) : null,
          rightY: pose ? round3(pose.right.y) : null,
        },
      })
    }
    flushAcc += dtMs
    if (flushAcc >= AUTO_FLUSH_MS) {
      flushAcc = 0
      telemetry.flush()
    }
  }

  return {
    get phase() {
      return phase
    },
    get kickIndex() {
      return results.length
    },
    get results() {
      return results
    },

    init(s: KeeperScene, calibration: Calibration | null) {
      scene = s
      const sw = calibration?.shoulderWidthWorld ?? 0.4
      swMetres = sw > 0.05 ? sw : 0.4
      phase = 'idle'
      lastSceneStriker = null
      ballVisible = false
      restBall()
      s.reset()
    },

    onPoseFrame(body: BodyFrame | null) {
      if (disposed) return
      const raw = body ? keeperPoseFromBody(body) : null
      if (!body || !raw) {
        if (bodyTracked) untrackedSinceClock = clock
        bodyTracked = false
        bodyPose.tracked = false
        return
      }
      const tS = body.t / 1000
      // After a long gap, restart the filters so they do not smear across the jump.
      const gapMs = bodyT >= 0 ? body.t - bodyT : Infinity
      if (!bodyTracked && gapMs > UNTRACKED_GRACE_MS) {
        filters.left.reset()
        filters.right.reset()
        filters.torsoTop.reset()
        filters.torsoBottom.reset()
      }
      copyPose(bodyPrev, bodyPose)
      filters.left.filterInto(bodyPose.left, raw.left, tS)
      filters.right.filterInto(bodyPose.right, raw.right, tS)
      filters.torsoTop.filterInto(bodyPose.torsoTop, raw.torsoTop, tS)
      filters.torsoBottom.filterInto(bodyPose.torsoBottom, raw.torsoBottom, tS)
      bodyPose.tracked = raw.tracked
      const dtS = gapMs / 1000
      if (hasBodyPose && dtS > 0 && dtS < 0.25) {
        emaInto(bodyVel.left, bodyPose.left, bodyPrev.left, dtS)
        emaInto(bodyVel.right, bodyPose.right, bodyPrev.right, dtS)
        emaInto(bodyVel.torso, bodyPose.torsoTop, bodyPrev.torsoTop, dtS)
      } else {
        zeroVel(bodyVel)
      }
      hasBodyPose = true
      bodyTracked = true
      bodyT = body.t
    },

    setPointer(target: { x: number; y: number } | null) {
      if (disposed) return
      if (!target) {
        if (pointerActive) {
          pointerActive = false
          pointerHasLast = false
          zeroVel(pointerVel)
          prevValid = false
        }
        return
      }
      if (!pointerActive) {
        pointerActive = true
        pointerHasLast = false
        zeroVel(pointerVel)
        prevValid = false
      }
      pointerPoseInto(pointerCur, target)
    },

    startShootout(opts?: { practice?: boolean; mode?: RoundMode; countdownMs?: number; date?: Date }) {
      if (disposed) return
      mode = opts?.practice === true ? 'practice' : (opts?.mode ?? 'classic')
      practice = mode === 'practice'
      firstIdleMs = Math.max(0, opts?.countdownMs ?? 0)
      hitStopLeft = 0
      if (mode === 'daily') {
        dailyDate = dailyKey(opts?.date ?? new Date())
        dailyPlans = planDailyRound(dailySeed(dailyDate))
      }
      results = []
      slowMoLeft = 0
      timeScale = 1
      leftSaves = 0
      rightSaves = 0
      roundSaves = 0
      combo = 0
      telemetry.startRound()
      scene?.reset()
      phase = 'playing'
      lastSceneStriker = null
      tickAcc = 0
      flushAcc = 0
      beginKick(0)
    },

    update(dtMs: number) {
      if (disposed) return
      const dt = clamp(Number.isFinite(dtMs) ? dtMs : 0, 0, MAX_DT_MS)
      clock += dt
      const dtS = dt / 1000

      if (!pointerActive && !bodyTracked && dt > 0) {
        const k = Math.exp(-dt / VEL_DECAY_MS)
        scaleInto(bodyVel.left, k)
        scaleInto(bodyVel.right, k)
        scaleInto(bodyVel.torso, k)
      }
      updatePointerVel(dtS)
      updateMetrics()

      // Slow-mo after a save or goal scales only the game world (striker, ball). Pose velocities and
      // reaction timing stay on real time.
      // Hit-stop: freeze the world for a beat on a save, then the slow-mo eases it back.
      timeScale = hitStopLeft > 0 ? 0 : slowMoScale()
      if (hitStopLeft > 0) hitStopLeft = Math.max(0, hitStopLeft - dt)
      else if (slowMoLeft > 0) slowMoLeft = Math.max(0, slowMoLeft - dt)
      if (phase === 'playing') {
        advanceStage(dt * timeScale)
        // advanceStage may end the shootout; physics only while playing.
        if (phase === 'playing') runPhysics(dtS * timeScale)
      }

      // Remember the active glove positions for next update's swept interpolation.
      const pose = activePose()
      if (pose) {
        cp(prevLeft, pose.left)
        cp(prevRight, pose.right)
        prevValid = true
      } else {
        prevValid = false
      }

      queueTickIfDue(dt)
      pushScene()
    },

    get practice() {
      return practice
    },
    get mode() {
      return mode
    },

    setDifficulty(level: Difficulty) {
      difficulty = level
    },
    get difficulty() {
      return difficulty
    },

    flushTelemetry() {
      telemetry.flush()
    },

    get timeScale() {
      return timeScale
    },

    onKickResult(cb: (r: KickResult) => void) {
      kickCbs.push(cb)
    },
    onStrikerPhase(cb: (phase: StrikerPhase, kick: number) => void) {
      strikerCbs.push(cb)
    },
    onShootoutEnd(cb: (r: ShootoutResult) => void) {
      endCbs.push(cb)
    },

    get debug(): Record<string, number | string> {
      const vels = activeVel()
      return {
        phase,
        striker: phase === 'playing' ? sceneStriker() : 'idle',
        kick,
        zone: plan ? (plan.zone as Zone) : -1,
        targetX: plan ? round3(plan.target.x) : 0,
        targetY: plan ? round3(plan.target.y) : 0,
        ballSpeed: round3(len(ball.v)),
        ballZ: round3(ball.p.z),
        leftSpeed: round3(len(vels.left)),
        rightSpeed: round3(len(vels.right)),
        reactionMs: reactionMs === null ? '-' : Math.round(reactionMs),
        peakSWps: round3(peakMs / swMetres),
        tracked: pointerActive ? 'pointer' : bodyTracked ? 'yes' : 'no',
        source: source(),
        saves: results.filter((r) => r.outcome === 'save').length,
      }
    },

    dispose() {
      if (disposed) return
      telemetry.flush()
      disposed = true
      kickCbs = []
      strikerCbs = []
      endCbs = []
      phase = 'idle'
      ballLaunched = false
      ballVisible = false
      scene = null
    },
  }
}
