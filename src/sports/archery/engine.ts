// Aero Bow engine: per-arrow state machine (nock, aiming, flight, impact), camera and mouse draw,
// aim sway and stability, bullseye slow-mo, and MOTION_EVENTS telemetry. Research doc section 3 (Sport 3).
// No DOM and no Three.js: the scene is driven only through ArcheryScene. All time comes from update(dtMs).

import { createArcheryDetector, stabilityScore } from './detector.ts'
import { launchSpeed, simulateShot, solveLaunch, targetCenterAt, windForArrow } from './physics.ts'
import {
  ARM_HOLD_MS,
  ARM_TENSION,
  ARROWS_PER_ROUND,
  LAUNCH_POS,
  SWAY_WINDOW_MS,
  TARGET_CENTER,
  TARGET_RADIUS,
  TARGET_Z,
  type ArcheryEngine,
  type ArcheryPhase,
  type ArcheryScene,
  type ArcheryTelemetry,
  type ArcheryView,
  type BodyFrame,
  type Calibration,
  type DrawPhase,
  type DrawSample,
  type Hand,
  type InputSource,
  type ReleaseInfo,
  type RoundResult,
  type ShotFlight,
  type ShotResult,
  type Vec2,
  type Vec3,
} from './types.ts'

// ---- timings (ms) ----
const MAX_DT_MS = 100
/** Arrow appears on the string. Real ms. */
const NOCK_MS = 700
/** Score shown before the next arrow. Real ms, so slow-mo does not stretch it. */
const IMPACT_MS = 1300
const IMPACT_BULLSEYE_MS = 2300

// ---- camera aim ----
/** Target-plane metres per shoulder width of bow-wrist movement. */
const AIM_GAIN = 1.0
/** The reticle starts this far off the bull (random angle) so the player has to steer onto it. */
const AIM_START_MIN = 0.3
const AIM_START_MAX = 0.55
/** Keep aim points sane before solveLaunch. */
const AIM_X_MAX = 4
const AIM_Y_MIN = -1
const AIM_Y_MAX = 5

// ---- breathing sway (slow Lissajous, metres on the target plane) ----
const SWAY_X_M = 0.03
const SWAY_Y_M = 0.022
const SWAY_X_PERIOD_MS = 4100
const SWAY_Y_PERIOD_MS = 2900
/** Mouse sway is a fraction of the camera sway. */
const SWAY_MOUSE_SCALE = 0.5

// ---- mouse draw ----
/** Tension 0 -> 1 while held. */
const MOUSE_DRAW_MS = 900
/** Let-down: tension 1 -> 0 after an early let go. */
const MOUSE_LETDOWN_MS = 350
/** EMA time constant of the smoothed aim path used for mouse sway RMS. */
const MOUSE_SMOOTH_MS = 120

// ---- slow-mo (bullseye) ----
const SLOWMO_SCALE = 0.2
/** Fraction of the flight after which time starts to slow. */
const SLOWMO_START = 0.45
/** Real ms at SLOWMO_SCALE after impact, then real ms easing back to 1. */
const SLOWMO_HOLD_MS = 600
const SLOWMO_OUT_MS = 450

// ---- feedback ----
const SHAKE_HIT = 0.15
const SHAKE_BULLSEYE = 0.5
const SHAKE_MISS = 0.08
/** Steadiness (0..1) at which the camera hint switches from "Hold steady" to "Release!". */
const STEADY_HINT = 0.6

// ---- telemetry ----
const TICK_MS = 200
const AUTO_FLUSH_MS = 2500
const DEFAULT_SW_M = 0.4

const HINT_UNTRACKED = 'Step back: shoulders and both hands in view'
const HINT_IDLE = 'Push one arm out, pull the other back to draw'
const HINT_DRAWING = 'Pull further…'
const HINT_HOLD = 'Hold steady…'
const HINT_RELEASE = 'Release!'
const HINT_MOUSE = 'Hold click or Space to draw, let go to shoot'

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}
function smooth01(k: number): number {
  const u = clamp(k, 0, 1)
  return u * u * (3 - 2 * u)
}
function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}
/** JSON-safe number: NaN and Infinity become null. */
function num(x: number): number | null {
  return Number.isFinite(x) ? round3(x) : null
}
function finite(x: number, fallback: number): number {
  return Number.isFinite(x) ? x : fallback
}
function clampAim(p: Vec2): Vec2 {
  return {
    x: clamp(finite(p.x, TARGET_CENTER.x), -AIM_X_MAX, AIM_X_MAX),
    y: clamp(finite(p.y, TARGET_CENTER.y), AIM_Y_MIN, AIM_Y_MAX),
  }
}
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

interface PendingShot {
  info: ReleaseInfo
  speed: number
  flight: ShotFlight
  source: InputSource
}

export function createArcheryEngine(opts: {
  telemetry: ArcheryTelemetry
  rng?: () => number
  sway?: boolean
}): ArcheryEngine {
  const telemetry = opts.telemetry
  const rng = opts.rng ?? Math.random
  const swayOn = opts.sway ?? true
  const detector = createArcheryDetector()

  let scene: ArcheryScene | null = null
  let calibration: Calibration | null = null
  let disposed = false

  // ---- callbacks ----
  let releaseCbs: ((info: ReleaseInfo, arrow: number) => void)[] = []
  let shotCbs: ((r: ShotResult) => void)[] = []
  let phaseCbs: ((phase: ArcheryPhase, arrow: number) => void)[] = []
  let endCbs: ((r: RoundResult) => void)[] = []

  // ---- clocks and round state ----
  let clock = 0 // real ms of update-driven time
  let roundMs = 0 // game ms since startRound (slowed by timeScale)
  let phase: ArcheryPhase = 'idle'
  let phaseMs = 0
  let arrow = 0
  let shots: ShotResult[] = []
  let wind = 0
  let driftPhase = 0
  let swayPhase = 0

  // ---- camera input ----
  let sample: DrawSample | null = null
  let aimOrigin: Vec2 | null = null
  let camBase: Vec2 | null = null // aimOrigin + gain * sample.aim, no sway
  let lastBowHand: Hand | null = null

  // ---- mouse input ----
  let mouse: { aim: Vec2; drawing: boolean } | null = null
  let mPhase: DrawPhase = 'idle'
  let mTension = 0
  let mAboveMs = 0
  let mArmedAt = 0
  let mSmooth: Vec2 | null = null
  let mDev: { t: number; d2: number }[] = []
  let mRmsM = 0

  // ---- live aim ----
  let aimPoint: Vec2 | null = null

  // ---- flight ----
  let pending: PendingShot | null = null
  let flightT = 0 // game ms since release
  const arrowPos: Vec3 = { x: LAUNCH_POS.x, y: LAUNCH_POS.y, z: LAUNCH_POS.z }
  const arrowDir: Vec3 = { x: 0, y: 0, z: -1 }
  let impactHoldMs = IMPACT_MS

  // ---- slow-mo ----
  let slowMo: 'none' | 'flight' | 'hold' | 'out' = 'none'
  let slowMoLeft = 0
  let followCam = false
  let timeScale = 1

  // ---- telemetry clocks ----
  let tickAcc = 0
  let flushAcc = 0

  let view: ArcheryView = { phase: 'idle', arrow: 0, tension: 0, drawPhase: 'idle', steadiness: null, hint: null, wind: 0 }

  function swMetres(): number {
    const sw = calibration?.shoulderWidthWorld ?? DEFAULT_SW_M
    return sw > 0.05 ? sw : DEFAULT_SW_M
  }
  function mouseActive(): boolean {
    return mouse !== null
  }
  function source(): InputSource {
    return mouseActive() || !calibration ? 'mouse' : 'camera'
  }
  function running(): boolean {
    return phase !== 'idle' && phase !== 'ended'
  }
  function targetNow(): Vec2 {
    return targetCenterAt(arrow, roundMs, driftPhase)
  }
  /** Breathing sway at the current clock, metres. */
  function swayAt(scale: number): Vec2 {
    if (!swayOn) return { x: 0, y: 0 }
    const t = clock
    return {
      x: scale * SWAY_X_M * Math.sin((2 * Math.PI * t) / SWAY_X_PERIOD_MS + swayPhase),
      y: scale * SWAY_Y_M * Math.sin((2 * Math.PI * t) / SWAY_Y_PERIOD_MS + 1.7 * swayPhase),
    }
  }
  function pickOrigin(): Vec2 {
    const r = AIM_START_MIN + (AIM_START_MAX - AIM_START_MIN) * rng()
    const a = rng() * 2 * Math.PI
    return { x: TARGET_CENTER.x + r * Math.cos(a), y: TARGET_CENTER.y + r * Math.sin(a) }
  }
  function curHand(): Hand {
    return (mouseActive() ? null : sample?.bowHand) ?? lastBowHand ?? 'left'
  }
  function setPhase(p: ArcheryPhase): void {
    phase = p
    phaseMs = 0
    const a = p === 'ended' ? shots.length : arrow
    for (const cb of phaseCbs) cb(p, a)
  }

  function resetMouseDraw(): void {
    mPhase = 'idle'
    mTension = 0
    mAboveMs = 0
    mArmedAt = 0
    mSmooth = null
    mDev = []
    mRmsM = 0
  }

  function beginArrow(n: number): void {
    arrow = n
    wind = windForArrow(n, rng)
    driftPhase = rng() * 2 * Math.PI
    swayPhase = rng() * 2 * Math.PI
    aimOrigin = null
    camBase = null
    aimPoint = null
    pending = null
    flightT = 0
    resetMouseDraw()
    detector.reset()
    sample = null
    scene?.setWind(wind)
    setPhase('nock')
  }

  function enterAiming(): void {
    detector.reset()
    sample = null
    aimOrigin = null
    camBase = null
    resetMouseDraw()
    setPhase('aiming')
  }

  // ---- release and flight ----

  function release(info: ReleaseInfo, aim: Vec2, src: InputSource): void {
    if (phase !== 'aiming' || disposed) return
    const a = arrow
    const ph = driftPhase
    const t0 = roundMs
    const p = clampAim(aim)
    const tension = clamp(finite(info.tension, 0), 0, 1)
    const speed = launchSpeed(tension)
    const from: Vec3 = { x: LAUNCH_POS.x, y: LAUNCH_POS.y, z: LAUNCH_POS.z }
    const velocity = solveLaunch(from, { x: p.x, y: p.y, z: TARGET_Z }, speed)
    const flight = simulateShot({
      from,
      velocity,
      windAccel: wind,
      targetCenterAt: (ms) => targetCenterAt(a, t0 + ms, ph),
    })
    pending = { info: { ...info, tension }, speed, flight, source: src }
    flightT = 0
    arrowPos.x = from.x
    arrowPos.y = from.y
    arrowPos.z = from.z
    arrowDir.x = velocity.x
    arrowDir.y = velocity.y
    arrowDir.z = velocity.z
    aimPoint = p
    if (flight.score === 10) {
      slowMo = 'flight'
      followCam = true
      scene?.setFollowCam(true)
    }
    const hit = flight.hit
    telemetry.emit({
      event_type: 'ARROW_RELEASE',
      peak_velocity: src === 'camera' ? num(info.peakVelocity) : null,
      reaction_ms: null,
      accuracy_score: flight.score * 10,
      symmetry_ratio: null,
      metrics: {
        arrow: a,
        score: flight.score,
        ring: flight.score,
        bullseye: flight.score === 10,
        hitX: hit ? round3(hit.x) : null,
        hitY: hit ? round3(hit.y) : null,
        radius: num(flight.radius),
        tension: round3(tension),
        launchSpeed: round3(speed),
        flightMs: Math.round(flight.flightMs),
        wind: round3(wind),
        windErrX: num(flight.windErrX),
        rmsSway: num(info.rmsSway),
        rmsSwayMm: num(info.rmsSwayMm),
        stability: num(info.stability),
        holdMs: Math.round(finite(info.holdMs, 0)),
        bowHand: src === 'camera' ? (info.bowHand === 'left' ? 'L' : 'R') : null,
        trigger: info.trigger,
        bowElbowDeg: num(info.bowElbowDeg),
        drawElbowDeg: num(info.drawElbowDeg),
        targetX: round3(flight.targetCenter.x),
        source: src,
      },
    })
    for (const cb of releaseCbs) cb(pending.info, a)
    if (phase !== 'aiming' || disposed) return // a callback restarted or disposed
    setPhase('flight')
  }

  function mouseRelease(): void {
    const p = aimPoint ?? clampAim(mouse?.aim ?? TARGET_CENTER)
    const rmsSwayMm = mRmsM * 1000
    const info: ReleaseInfo = {
      t: now(),
      tension: mTension,
      aim: { x: p.x, y: p.y }, // mouse: the target-plane aim point itself
      bowHand: lastBowHand ?? 'left',
      trigger: 'mouse',
      peakVelocity: 0,
      rmsSway: mRmsM / swMetres(), // nominal shoulder widths
      rmsSwayMm,
      stability: stabilityScore(rmsSwayMm),
      holdMs: Math.max(0, clock - mArmedAt),
      bowElbowDeg: NaN,
      drawElbowDeg: NaN,
    }
    release(info, p, 'mouse')
  }

  function impact(): void {
    if (!pending) return
    const { flight, info, speed, source: src } = pending
    const last = flight.vel[flight.vel.length - 1]
    const dir: Vec3 = last ? { x: last.x, y: last.y, z: last.z } : { x: arrowDir.x, y: arrowDir.y, z: arrowDir.z }
    const p: Vec3 = { x: flight.impact.x, y: flight.impact.y, z: flight.impact.z }
    const bullseye = flight.score === 10
    if (flight.end === 'target' && flight.radius < TARGET_RADIUS) scene?.stickArrow(p, dir, flight.score)
    else scene?.missArrow(p, dir)
    scene?.setArrow(p, dir, false)
    scene?.shake(bullseye ? SHAKE_BULLSEYE : flight.score > 0 ? SHAKE_HIT : SHAKE_MISS)
    if (slowMo === 'flight') {
      slowMo = 'hold'
      slowMoLeft = SLOWMO_HOLD_MS
    }
    const result: ShotResult = {
      arrow,
      score: flight.score,
      bullseye,
      hit: flight.hit ? { x: flight.hit.x, y: flight.hit.y } : null,
      radius: flight.radius,
      tension: info.tension,
      launchSpeed: speed,
      flightMs: flight.flightMs,
      wind,
      windErrX: flight.windErrX,
      rmsSway: info.rmsSway,
      rmsSwayMm: info.rmsSwayMm,
      stability: info.stability,
      holdMs: info.holdMs,
      peakVelocity: src === 'camera' ? info.peakVelocity : 0,
      bowHand: src === 'camera' ? info.bowHand : null,
      trigger: info.trigger,
      source: src,
    }
    shots.push(result)
    pending = null
    impactHoldMs = bullseye ? IMPACT_BULLSEYE_MS : IMPACT_MS
    setPhase('impact')
    for (const cb of shotCbs) cb(result)
  }

  function advanceFlight(gdt: number): void {
    if (!pending) return
    const f = pending.flight
    flightT += gdt
    const n = f.path.length
    if (n === 0 || flightT >= f.flightMs || !(f.stepS > 0)) {
      impact()
      return
    }
    // The last path interval ends at the impact and is shorter than stepS.
    const tS = flightT / 1000
    const tEnd = f.flightMs / 1000
    const i = clamp(Math.floor(tS / f.stepS), 0, Math.max(n - 2, 0))
    const j = Math.min(i + 1, n - 1)
    const t0 = i * f.stepS
    const t1 = j === n - 1 ? tEnd : t0 + f.stepS
    const k = t1 > t0 ? clamp((tS - t0) / (t1 - t0), 0, 1) : 1
    const a = f.path[i]
    const b = f.path[j]
    arrowPos.x = a.x + (b.x - a.x) * k
    arrowPos.y = a.y + (b.y - a.y) * k
    arrowPos.z = a.z + (b.z - a.z) * k
    const v = f.vel[i]
    if (v) {
      arrowDir.x = v.x
      arrowDir.y = v.y
      arrowDir.z = v.z
    }
  }

  // ---- slow-mo ----

  function updateSlowMo(dt: number): void {
    if (slowMo === 'flight' && pending) {
      const u = flightT / Math.max(pending.flight.flightMs, 1)
      timeScale = 1 - (1 - SLOWMO_SCALE) * smooth01((u - SLOWMO_START) / (1 - SLOWMO_START))
    } else if (slowMo === 'hold') {
      timeScale = SLOWMO_SCALE
      slowMoLeft -= dt
      if (slowMoLeft <= 0) {
        slowMo = 'out'
        slowMoLeft = SLOWMO_OUT_MS
        if (followCam) {
          followCam = false
          scene?.setFollowCam(false)
        }
      }
    } else if (slowMo === 'out') {
      slowMoLeft -= dt
      timeScale = SLOWMO_SCALE + (1 - SLOWMO_SCALE) * smooth01(1 - slowMoLeft / SLOWMO_OUT_MS)
      if (slowMoLeft <= 0) {
        slowMo = 'none'
        timeScale = 1
      }
    } else {
      slowMo = 'none'
      timeScale = 1
    }
  }

  function stopSlowMo(): void {
    slowMo = 'none'
    slowMoLeft = 0
    timeScale = 1
    if (followCam) {
      followCam = false
      scene?.setFollowCam(false)
    }
  }

  // ---- aiming ----

  function updateMouse(dt: number): void {
    const m = mouse
    if (!m) return
    const raw = clampAim(m.aim)
    const sw = swayAt(SWAY_MOUSE_SCALE)
    const p = { x: raw.x + sw.x, y: raw.y + sw.y }
    aimPoint = p
    // Sway: RMS of the aim point around its own smoothed path over the last SWAY_WINDOW_MS.
    if (!mSmooth) mSmooth = { x: p.x, y: p.y }
    else {
      const a = 1 - Math.exp(-dt / MOUSE_SMOOTH_MS)
      mSmooth.x += a * (p.x - mSmooth.x)
      mSmooth.y += a * (p.y - mSmooth.y)
    }
    const dx = p.x - mSmooth.x
    const dy = p.y - mSmooth.y
    mDev.push({ t: clock, d2: dx * dx + dy * dy })
    while (mDev.length > 0 && mDev[0].t < clock - SWAY_WINDOW_MS) mDev.shift()
    let sum = 0
    for (const d of mDev) sum += d.d2
    mRmsM = mDev.length > 0 ? Math.sqrt(sum / mDev.length) : 0

    if (m.drawing) {
      if (mPhase === 'idle') mPhase = 'drawing'
      mTension = Math.min(1, mTension + dt / MOUSE_DRAW_MS)
      if (mPhase === 'drawing') {
        if (mTension > ARM_TENSION) {
          mAboveMs += dt
          if (mAboveMs >= ARM_HOLD_MS) {
            mPhase = 'armed'
            mArmedAt = clock
          }
        } else mAboveMs = 0
      }
    } else if (mPhase === 'armed') {
      mouseRelease()
    } else {
      // Let-down: no shot, tension eases back.
      mPhase = 'idle'
      mAboveMs = 0
      mTension = Math.max(0, mTension - dt / MOUSE_LETDOWN_MS)
    }
  }

  function updateCameraAim(): void {
    if (camBase && sample?.phase === 'armed') {
      const sw = swayAt(1)
      aimPoint = clampAim({ x: camBase.x + sw.x, y: camBase.y + sw.y })
    } else {
      aimPoint = null
    }
  }

  // ---- live values ----

  function liveTension(): number {
    if (phase !== 'aiming') return 0
    if (mouseActive()) return mTension
    return sample ? clamp(finite(sample.tension, 0), 0, 1) : 0
  }
  function liveDrawPhase(): DrawPhase {
    if (phase !== 'aiming') return 'idle'
    if (mouseActive()) return mPhase
    return sample?.phase ?? 'idle'
  }
  /** Live sway, mm, while armed. */
  function liveSwayMm(): number | null {
    if (phase !== 'aiming') return null
    if (mouseActive()) return mPhase === 'armed' ? mRmsM * 1000 : null
    return sample?.phase === 'armed' ? sample.swayMm : null
  }
  function liveSteadiness(): number | null {
    const mm = liveSwayMm()
    if (mm === null || !Number.isFinite(mm)) return liveDrawPhase() === 'armed' ? 0 : null
    return clamp(stabilityScore(mm) / 100, 0, 1)
  }
  function hint(steadiness: number | null): string | null {
    if (phase !== 'aiming') return null
    if (mouseActive() || !calibration) return HINT_MOUSE
    if (!sample || !sample.tracked) return HINT_UNTRACKED
    if (sample.phase === 'idle') return HINT_IDLE
    if (sample.phase === 'drawing') return HINT_DRAWING
    return (steadiness ?? 0) >= STEADY_HINT ? HINT_RELEASE : HINT_HOLD
  }

  function pushScene(tension: number, drawPhase: DrawPhase, steadiness: number | null): void {
    if (!scene) return
    scene.setTarget(targetNow())
    const hand = curHand()
    if (phase === 'aiming') {
      scene.setBow(tension, hand, true)
      // Camera: hidden until armed. Mouse: always shown (the cursor is the aim).
      const show = aimPoint !== null && (mouseActive() || drawPhase === 'armed')
      scene.setReticle(show ? aimPoint : null, steadiness ?? 0)
    } else {
      scene.setBow(0, hand, phase === 'nock')
      scene.setReticle(null, 0)
    }
    if (phase === 'flight' && pending) scene.setArrow(arrowPos, arrowDir, true)
  }

  function queueTicks(dt: number, tension: number, drawPhase: DrawPhase): void {
    if (!running()) return
    if (phase === 'aiming') {
      tickAcc += dt
      while (tickAcc >= TICK_MS) {
        tickAcc -= TICK_MS
        const sway = liveSwayMm()
        telemetry.queueTick({
          metrics: {
            arrow,
            tension: round3(tension),
            drawPhase,
            swayMm: sway === null ? null : num(sway),
            aimX: aimPoint ? round3(aimPoint.x) : null,
            aimY: aimPoint ? round3(aimPoint.y) : null,
            source: source(),
          },
        })
      }
    }
    flushAcc += dt
    if (flushAcc >= AUTO_FLUSH_MS) {
      flushAcc = 0
      telemetry.flush()
    }
  }

  // ---- round end ----

  /**
   * Arcade score = total * 100 + bullseyes * 150 + round(avgStability) * 2.
   * A perfect steady round: 5000 + 750 + 200 = 5950.
   */
  function endRound(): void {
    stopSlowMo()
    let total = 0
    let bullseyes = 0
    let stabSum = 0
    let bestStab = 0
    let bestSpeed = 0
    let bestPeak = 0
    const hits: Vec2[] = []
    for (const s of shots) {
      total += s.score
      if (s.bullseye) bullseyes++
      const st = finite(s.stability, 0)
      stabSum += st
      if (st > bestStab) bestStab = st
      if (s.launchSpeed > bestSpeed) bestSpeed = s.launchSpeed
      if (s.peakVelocity > bestPeak) bestPeak = s.peakVelocity
      if (s.hit && s.score > 0) hits.push(s.hit)
    }
    const avgStability = shots.length > 0 ? stabSum / shots.length : 0
    let grouping: number | null = null
    if (hits.length >= 2) {
      let cx = 0
      let cy = 0
      for (const h of hits) {
        cx += h.x
        cy += h.y
      }
      cx /= hits.length
      cy /= hits.length
      let d = 0
      for (const h of hits) d += Math.hypot(h.x - cx, h.y - cy)
      grouping = d / hits.length
    }
    const score = total * 100 + bullseyes * 150 + Math.round(avgStability) * 2
    const result: RoundResult = {
      shots: shots.slice(),
      total,
      bullseyes,
      avgStability,
      bestStability: bestStab,
      grouping,
      score,
    }
    telemetry.flush()
    flushAcc = 0
    tickAcc = 0
    // Round summary for the shell dashboard (src/shell/records.ts reads TICK + metrics.summary).
    // counts.total feeds its "best" counter, so for archery it is the ring total.
    telemetry.emit({
      event_type: 'TICK',
      peak_velocity: bestPeak > 0 ? round3(bestPeak) : null,
      reaction_ms: null,
      accuracy_score: Math.round((total / (ARROWS_PER_ROUND * 10)) * 100),
      symmetry_ratio: null,
      metrics: {
        summary: true,
        outcome: total >= 35 ? 'win' : 'loss',
        counts: { total, bullseyes, arrows: shots.length },
        accuracyPct: Math.round((total / (ARROWS_PER_ROUND * 10)) * 100),
        bestSpeed: round3(bestSpeed),
        score,
        avgStability: round3(avgStability),
        grouping: grouping === null ? null : round3(grouping),
        source: source(),
      },
    })
    setPhase('ended')
    for (const cb of endCbs) cb(result)
  }

  function advancePhase(dt: number, gdt: number): void {
    if (phase === 'nock') {
      phaseMs += dt
      if (phaseMs >= NOCK_MS) enterAiming()
    } else if (phase === 'aiming') {
      if (mouseActive()) updateMouse(dt)
      else updateCameraAim()
    } else if (phase === 'flight') {
      advanceFlight(gdt)
    } else if (phase === 'impact') {
      phaseMs += dt
      if (phaseMs >= impactHoldMs) {
        if (shots.length >= ARROWS_PER_ROUND) endRound()
        else beginArrow(arrow + 1)
      }
    }
  }

  return {
    get phase() {
      return phase
    },
    get arrowIndex() {
      return shots.length
    },
    get shots() {
      return shots
    },
    get view() {
      return view
    },
    get timeScale() {
      return timeScale
    },

    init(s: ArcheryScene, cal: Calibration | null) {
      if (disposed) return
      scene = s
      calibration = cal
      phase = 'idle'
      stopSlowMo()
      s.reset()
      s.setTarget({ x: TARGET_CENTER.x, y: TARGET_CENTER.y })
      s.setWind(0)
      s.setReticle(null, 0)
      s.setBow(0, lastBowHand ?? 'left', false)
    },

    onPoseFrame(body: BodyFrame | null) {
      if (disposed || !calibration) return
      let s: DrawSample
      try {
        s = detector.push(body)
      } catch {
        return
      }
      sample = s
      if (s.bowHand) lastBowHand = s.bowHand
      if (phase !== 'aiming' || mouseActive()) return
      if (s.phase === 'armed' && !aimOrigin) aimOrigin = pickOrigin()
      if (aimOrigin) {
        camBase = { x: aimOrigin.x + AIM_GAIN * finite(s.aim.x, 0), y: aimOrigin.y + AIM_GAIN * finite(s.aim.y, 0) }
      }
      const r = s.release
      if (r) {
        const o = aimOrigin ?? pickOrigin()
        const sw = swayAt(1)
        const aim = {
          x: o.x + AIM_GAIN * finite(r.aim.x, 0) + sw.x,
          y: o.y + AIM_GAIN * finite(r.aim.y, 0) + sw.y,
        }
        if (r.bowHand) lastBowHand = r.bowHand
        release(r, aim, 'camera')
      }
    },

    setMouse(state: { aim: Vec2; drawing: boolean } | null) {
      if (disposed) return
      if (!state) {
        if (mouse) resetMouseDraw()
        mouse = null
        return
      }
      if (!mouse) resetMouseDraw()
      mouse = { aim: { x: state.aim.x, y: state.aim.y }, drawing: !!state.drawing }
    },

    startRound() {
      if (disposed) return
      stopSlowMo()
      shots = []
      roundMs = 0
      tickAcc = 0
      flushAcc = 0
      telemetry.startRound()
      scene?.reset()
      beginArrow(0)
      view = { phase, arrow, tension: 0, drawPhase: 'idle', steadiness: null, hint: null, wind }
    },

    update(dtMs: number) {
      if (disposed) return
      const dt = clamp(Number.isFinite(dtMs) ? dtMs : 0, 0, MAX_DT_MS)
      clock += dt
      updateSlowMo(dt)
      const gdt = dt * timeScale
      if (running()) roundMs += gdt
      advancePhase(dt, gdt)
      if (disposed) return
      const tension = liveTension()
      const drawPhase = liveDrawPhase()
      const steadiness = drawPhase === 'armed' ? liveSteadiness() : null
      queueTicks(dt, tension, drawPhase)
      pushScene(tension, drawPhase, steadiness)
      view = { phase, arrow, tension, drawPhase, steadiness, hint: hint(steadiness), wind }
    },

    flushTelemetry() {
      telemetry.flush()
    },

    dispose() {
      if (disposed) return
      telemetry.flush()
      disposed = true
      releaseCbs = []
      shotCbs = []
      phaseCbs = []
      endCbs = []
      phase = 'idle'
      pending = null
      shots = []
      mouse = null
      sample = null
      scene = null
      timeScale = 1
    },

    onRelease(cb) {
      if (!disposed) releaseCbs.push(cb)
    },
    onShot(cb) {
      if (!disposed) shotCbs.push(cb)
    },
    onPhase(cb) {
      if (!disposed) phaseCbs.push(cb)
    },
    onRoundEnd(cb) {
      if (!disposed) endCbs.push(cb)
    },

    get debug(): Record<string, number | string> {
      const out: Record<string, number | string> = {
        phase,
        arrow,
        tension: round3(liveTension()),
        drawPhase: liveDrawPhase(),
        wind: round3(wind),
        aimX: aimPoint ? round3(aimPoint.x) : '-',
        aimY: aimPoint ? round3(aimPoint.y) : '-',
        timeScale: round3(timeScale),
        lastScore: shots.length > 0 ? shots[shots.length - 1].score : '-',
        source: source(),
      }
      if (!disposed) {
        for (const [k, v] of Object.entries(detector.debug)) out[`det.${k}`] = v
      }
      return out
    },
  }
}
