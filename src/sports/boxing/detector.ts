// Boxing motion detector (research doc section 3, Sport 1 "Motion Detection Logic").
// Pure: no DOM, time comes only from BodyFrame.t. 2D values are in body space (shoulder widths, SW,
// y down, mirror view). 3D values are world metres re-expressed in a slowly learned TORSO frame
// (x along the shoulders, y down the spine, z toward the camera is negative), so a laptop webcam tilted up
// or down does not turn "forward" into "up". Elbow angles are rotation invariant.
//
// False positive defences: a hand re-arms only once its wrist has pulled back from where the punch ended
// (spatial retraction hysteresis); a hand rising from below the waist is a guard raise, never an uppercut;
// arm joints under velocityMinVisibility freeze that hand's velocity; a single-frame jump in shoulder
// width (a passer-by or a tracker swap) suppresses everything for a moment.
// Cross vs jab uses shoulder yaw against the player's own stance and the calibrated lead hand.
// Hook needs a bent elbow and a lateral speed that clearly beats vertical and forward speed.
// The neutral nose (for duck and slip) re-centres only while the player is idle.
import type { OneEuroParams } from '../../pose/oneEuro.ts'
import { LM } from '../../pose/types.ts'
import type { BodyFrame, Calibration, Hand, Joint } from '../../pose/types.ts'
import type { BoxingActions, BoxingDetector, Punch, PunchKind, SlipKind } from './types.ts'

export interface BoxingDetectorConfig {
  /** 0 to 1. Below this a hand is not tracked at all (no guard, no punches). Guard and slip need the nose too. */
  minVisibility: number
  /** 0 to 1. Below this (shoulder, elbow or wrist) the hand's velocity freezes: no new samples, no punches. */
  velocityMinVisibility: number
  /** ms. A hand frozen longer than this drops its motion history, so no velocity spans the occlusion. */
  freezeMaxMs: number
  /** ms. A longer gap between frames, or a t that does not increase, clears all motion history. */
  maxGapMs: number
  /** ms. Derivatives compare against the newest sample at least this old (span about 55 to 80 ms at 15 to 60 fps). */
  velocityWindowMs: number
  /** ms. Punch.peakVelocity is the highest wrist speed within this window; the punch's start point is the oldest sample in it. */
  peakWindowMs: number
  /** ms. Minimum time between two punches of the same hand. */
  cooldownMs: number
  /** Ratio. Re-arm once the wrist has moved back this fraction of the punch's travel away from where it ended... */
  retractFraction: number
  /** SW. ...measuring travel as at least this, so a tiny punch still needs a real pull-back. */
  retractMin: number
  /** ms. Safety valve: a hand that has been still this long after a punch re-arms even without retracting. */
  rearmTimeoutMs: number
  /** SW/s. "Still" for the safety valve, quiet frames and baselines: wrist slower than this relative to the torso. */
  rearmSpeed: number
  /** deg. Guard baselines learn only from quiet frames with the elbow bent below this. */
  rearmTheta: number
  /** ms. A hand is quiet (baselines learn from it) while it is still and its last punch is at least this old. */
  quietMs: number
  /** ms. Stance yaw, guard reach and torso frame baselines: running mean of quiet frames at first, then an EMA with this time constant. */
  baselineTauMs: number
  /** deg/s. Straight: minimum elbow extension speed d(theta)/dt... */
  straightMinDtheta: number
  /** ms. ...reached within this window, so at 15 fps a punch that straightens between two frames still counts. */
  straightDthetaWindowMs: number
  /** deg. Straight: minimum elbow angle (180 = straight arm). */
  straightMinTheta: number
  /** m. Straight: torso-frame z_wrist - z_shoulder must be below this (negative = wrist in front of the shoulder)... */
  straightMaxZReach: number
  /** m. ...and at least this far in front of that hand's guard baseline (its quiet reach with a bent arm). */
  straightMinForward: number
  /** SW/s. Thrust straight (forgiving path for monocular depth error): the wrist drives forward faster than this... */
  thrustMinFwd: number
  /** deg. ...the elbow opens past this... */
  thrustMinTheta: number
  /** deg/s. ...while extending at least this fast. Forward speed must also beat the 2D wrist speed. */
  thrustMinDtheta: number
  /** deg. A straight is a cross when the punching side's shoulder has yawed forward by more than this from the stance... */
  crossMinYaw: number
  /** deg. ...or, for the rear hand (by calibrated stance), by more than this. Otherwise it is a jab. */
  rearCrossMinYaw: number
  /** SW/s. Hook: minimum inward lateral wrist speed. */
  hookMinSpeed: number
  /** deg. Hook: elbow angle must be above this... */
  hookMinTheta: number
  /** deg. ...and below this. */
  hookMaxTheta: number
  /** Ratio. Hook: inward speed must exceed this times both the vertical and the forward speed. */
  hookMinLateralRatio: number
  /** SW. Hook: the wrist counts as crossing the torso midline once it is within this distance of it, coming from its own side. */
  hookMidlineMargin: number
  /** ms. Hook: the midline crossing must be at most this old. */
  hookCrossWindowMs: number
  /** SW/s. Uppercut: minimum upward wrist speed (-v_y). */
  uppercutMinSpeed: number
  /** SW. Uppercut: the wrist must have been more than this far below its shoulder line... */
  uppercutStartBelow: number
  /** SW. ...but never more than this far below it (that is a hand coming up from the waist: a guard raise)... */
  uppercutMaxStartBelow: number
  /** ms. ...within this window (the start of the motion). */
  uppercutStartWindowMs: number
  /** Ratio. No uppercut while the other wrist rises faster than this times this wrist's upward speed (both hands coming up to guard). */
  uppercutMaxOtherRise: number
  /** Ratio. Uppercut: upward speed must exceed this times the lateral and forward speed. */
  dominanceRatio: number
  /** SW. Guard: both wrists within this 2D distance of the nose (and above their shoulders)... */
  guardMaxNoseDist: number
  /** deg. ...and both elbows bent below this, so a straight arm in front of the face is a punch, not a guard. */
  guardMaxTheta: number
  /** SW. Slip: |nose.x - baseline.x| above this. */
  slipMinNoseX: number
  /** SW. Duck: nose.y - baseline.y above this. */
  duckMinDrop: number
  /** ms. The nose baseline starts at the calibrated neutral nose and follows the nose with this EMA time constant, only while idle... */
  noseTauMs: number
  /** ms. ...and again once a slip or duck has been held this long, so stepping aside never leaves a permanent slip. */
  slipHoldMs: number
  /** SW. Guard, slip and duck switch off only once their distance is this far back past the threshold. */
  hysteresis: number
  /** Ratio. Single-frame tracking switch: shoulder width (BodyFrame.scale) changes by more than this between two frames... */
  frameJumpMax: number
  /** Ratio. Slower switch: the shoulder width changes by more than this... */
  switchMinJump: number
  /** ms. ...within this window. */
  switchWindowMs: number
  /** ms. Either switch clears motion history and suppresses punches and slips for this long. */
  switchSuppressMs: number
}

// Tuned to be forgiving for casual players, while each false-positive path has its own explicit gate.
// 2026-11-21: straightMinForward, thrustMinFwd, hookMinSpeed, uppercutMinSpeed and guardMaxNoseDist tuned on real
// webcam recordings (recordings/boxing_anon_*, motion lab /record.html); see the PR for before/after numbers.
export const DEFAULT_BOXING_CONFIG: BoxingDetectorConfig = {
  minVisibility: 0.35,
  velocityMinVisibility: 0.5,
  freezeMaxMs: 150,
  maxGapMs: 250,
  velocityWindowMs: 55,
  peakWindowMs: 150,
  cooldownMs: 200,
  retractFraction: 0.45,
  retractMin: 0.25,
  rearmTimeoutMs: 1500,
  rearmSpeed: 1,
  rearmTheta: 125,
  quietMs: 400,
  baselineTauMs: 3000,
  straightMinDtheta: 180,
  straightDthetaWindowMs: 120,
  straightMinTheta: 131,
  straightMaxZReach: -0.12,
  straightMinForward: 0.08,
  thrustMinFwd: 2.6,
  thrustMinTheta: 105,
  thrustMinDtheta: 90,
  crossMinYaw: 14,
  rearCrossMinYaw: 7,
  hookMinSpeed: 2.5,
  hookMinTheta: 60,
  hookMaxTheta: 130,
  hookMinLateralRatio: 1.3,
  hookMidlineMargin: 0.2,
  hookCrossWindowMs: 180,
  uppercutMinSpeed: 3,
  uppercutStartBelow: -0.1,
  uppercutMaxStartBelow: 0.9,
  uppercutStartWindowMs: 300,
  uppercutMaxOtherRise: 0.5,
  dominanceRatio: 1,
  guardMaxNoseDist: 0.55,
  guardMaxTheta: 145,
  slipMinNoseX: 0.3,
  duckMinDrop: 0.2,
  noseTauMs: 2500,
  slipHoldMs: 2500,
  hysteresis: 0.05,
  frameJumpMax: 0.25,
  switchMinJump: 0.35,
  switchWindowMs: 100,
  switchSuppressMs: 300,
}

/**
 * 1-euro filter tuning for boxing. The research doc's minCutoff 1.5 Hz / beta 0.08 lagged the start of
 * punches by a frame or two; a higher beta opens the filter sooner on fast moves while idle jitter stays smoothed.
 */
export const BOXING_FILTER: OneEuroParams = { minCutoff: 1.2, beta: 0.15, dCutoff: 1.0 }

type V3 = [number, number, number]

interface Sample {
  t: number
  /** Elbow angle, deg. */
  theta: number
  /** Wrist relative to the live torso centre (shoulder midpoint), body space. */
  relX: number
  relY: number
  /** Wrist position toward the other side, relative to the torso centre (negative = own side). */
  inward: number
  /** Wrist y - own shoulder y, body space (positive = below the shoulder line). */
  below: number
  /** Absolute wrist, body space. */
  bx: number
  by: number
  /** World wrist, metres (camera frame; only used for speed, which is rotation invariant). */
  wx: number
  wy: number
  wz: number
  /** Torso-frame z_wrist - z_shoulder, metres. */
  zReach: number
  /** zReach in shoulder widths, for 3D retraction distances. */
  zs: number
  /** Absolute wrist speed, SW/s (0 until a velocity exists). */
  speed: number
  /** d(theta)/dt, deg/s (0 until a velocity exists). */
  dtheta: number
}

interface Motion {
  /** deg/s */
  dtheta: number
  /** Wrist velocity relative to the torso centre, SW/s, body space (y down). */
  vx: number
  vy: number
  /** Speed of the wrist toward the camera relative to its shoulder, SW/s. */
  fwd: number
  /** Wrist speed relative to the torso, SW/s. */
  rel: number
}

/** Slow personal reference value. v is null until the first sample. */
interface Baseline {
  v: number | null
  /** ms of samples learned so far. */
  ms: number
}

interface HandState {
  readonly hand: Hand
  /** -1: own side is screen left (player's left in the mirror view), +1: screen right. */
  readonly side: number
  readonly shoulder: number
  readonly elbow: number
  readonly wrist: number
  hist: Sample[]
  /** Newest sample this frame even when velocity is frozen (for the guard). */
  last: Sample | null
  motion: Motion | null
  /** t when velocity froze for low visibility, null while visible. */
  frozenSince: number | null
  armed: boolean
  lastPunchT: number
  /** When this hand last re-armed. Extension evidence older than this belongs to the previous punch. */
  armedT: number
  /** Where the last punch started and its outward direction, for retraction. Body space x, y and z in SW. */
  punchStart: V3 | null
  punchDir: V3 | null
  /** Furthest outward progress along punchDir since the punch (the wrist keeps extending after the trigger). */
  punchMaxOut: number
  /** t since which the hand has been still after a punch, for the re-arm safety valve. */
  stillSince: number | null
  crossT: number | null
  /** Quiet zReach with a bent arm: where this hand rests in its guard. */
  guardZ: Baseline
}

/** Orthonormal torso axes in camera-world coordinates: ex along the shoulders (to the player's right), ey down the spine. */
interface TorsoAxes {
  ex: V3
  ey: V3
  ez: V3
  ms: number
}

const DEG = 180 / Math.PI

const newBaseline = (): Baseline => ({ v: null, ms: 0 })

/** Running mean while younger than tauMs, then an EMA with that time constant. dtMs 0 only seeds an empty baseline. */
function follow(b: Baseline, x: number, dtMs: number, tauMs: number): void {
  b.ms += dtMs
  b.v = b.v === null || b.ms <= 0 ? x : b.v + (x - b.v) * Math.min(1, dtMs / Math.min(b.ms, tauMs))
}

function newHand(hand: Hand): HandState {
  const left = hand === 'left'
  return {
    hand,
    side: left ? -1 : 1,
    shoulder: left ? LM.L_SHOULDER : LM.R_SHOULDER,
    elbow: left ? LM.L_ELBOW : LM.R_ELBOW,
    wrist: left ? LM.L_WRIST : LM.R_WRIST,
    hist: [],
    last: null,
    motion: null,
    frozenSince: null,
    armed: true,
    lastPunchT: -Infinity,
    armedT: -Infinity,
    punchStart: null,
    punchDir: null,
    punchMaxOut: 0,
    stillSince: null,
    crossT: null,
    guardZ: newBaseline(),
  }
}

const finite = (j: Joint | undefined): j is Joint =>
  j !== undefined && Number.isFinite(j.x) && Number.isFinite(j.y) && Number.isFinite(j.z)

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: V3): number => Math.hypot(a[0], a[1], a[2])
const scaleV = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
const unit = (a: V3): V3 | null => {
  const n = norm(a)
  return n > 1e-6 ? scaleV(a, 1 / n) : null
}
const v3 = (j: Joint): V3 => [j.x, j.y, j.z]

/** Orthonormal axes from a shoulder direction and a spine-down direction. null when degenerate. */
function axesFrom(right: V3, down: V3): Omit<TorsoAxes, 'ms'> | null {
  const ey = unit(down)
  if (!ey) return null
  const ex = unit(sub(right, scaleV(ey, dot(right, ey))))
  if (!ex) return null
  return { ex, ey, ez: cross3(ex, ey) }
}

/** Angle at b between a and c in 3D, degrees. null when a limb has no length. */
function angle3(a: Joint, b: Joint, c: Joint): number | null {
  const ux = a.x - b.x, uy = a.y - b.y, uz = a.z - b.z
  const vx = c.x - b.x, vy = c.y - b.y, vz = c.z - b.z
  const n = Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz)
  if (!(n > 1e-9)) return null
  const cos = (ux * vx + uy * vy + uz * vz) / n
  return Math.acos(Math.min(1, Math.max(-1, cos))) * DEG
}

const num = (v: number): number => (Number.isFinite(v) ? v : 0)

const pos = (s: Sample): V3 => [s.bx, s.by, s.zs]

export function createBoxingDetector(config: Partial<BoxingDetectorConfig> = {}): BoxingDetector {
  const cfg: BoxingDetectorConfig = { ...DEFAULT_BOXING_CONFIG, ...config }
  const keepMs = Math.max(
    cfg.velocityWindowMs,
    cfg.peakWindowMs,
    cfg.straightDthetaWindowMs,
    cfg.uppercutStartWindowMs,
    cfg.hookCrossWindowMs,
  )
  const hands: [HandState, HandState] = [newHand('left'), newHand('right')]
  let lastT: number | null = null
  let guard = false
  let slip: SlipKind | null = null
  /** When the current slip or duck started, null while upright. */
  let slipT: number | null = null
  /** Shoulder-line yaw in the torso frame, deg: grows as the right shoulder comes forward. */
  let yaw = 0
  /** Quiet yaw: the player's own stance, square or bladed. */
  let stance = newBaseline()
  let torso: TorsoAxes | null = null
  /** Nose baseline in body space, null until seeded from the calibration's neutral nose. */
  let nose: { x: number; y: number } | null = null
  let calibration: Calibration | null = null
  let lead: Hand = 'left'
  /** Live shoulder widths within switchWindowMs, plus one older sample. */
  let scales: Array<{ t: number; s: number }> = []
  let prevScale: number | null = null
  let suppressUntil = -Infinity
  let noseX = 0
  let duckY = 0

  function untrack(h: HandState): void {
    h.hist = []
    h.last = null
    h.motion = null
    h.crossT = null
    h.frozenSince = null
  }

  /** Null frames and gaps: no derivatives across them. Cooldowns, arming and baselines survive. */
  function clearHistory(): void {
    for (const h of hands) untrack(h)
    lastT = null
    yaw = 0
    scales = []
    prevScale = null
  }

  /** A new calibration is a new body space and maybe a new player: learn everything again. */
  function resetBaselines(): void {
    stance = newBaseline()
    torso = null
    for (const h of hands) h.guardZ = newBaseline()
    nose = null
  }

  const still = (h: HandState): boolean => h.motion !== null && h.motion.rel < cfg.rearmSpeed
  const quiet = (h: HandState, t: number): boolean => still(h) && t - h.lastPunchT >= cfg.quietMs

  /** A sudden change of shoulder width is a different body: no derivatives across it, no actions for a moment. */
  function checkSwitch(t: number, scale: number): void {
    if (!(Number.isFinite(scale) && scale > 0)) return
    const prev = prevScale
    prevScale = scale
    const frameJump = prev !== null && Math.abs(scale / prev - 1) > cfg.frameJumpMax
    scales.push({ t, s: scale })
    while (scales.length > 2 && scales[1].t <= t - cfg.switchWindowMs) scales.shift()
    let lo = Infinity
    let hi = 0
    for (const p of scales) {
      lo = Math.min(lo, p.s)
      hi = Math.max(hi, p.s)
    }
    if (!frameJump && hi <= lo * (1 + cfg.switchMinJump)) return
    for (const h of hands) untrack(h)
    scales = [{ t, s: scale }]
    suppressUntil = t + cfg.switchSuppressMs
  }

  /** World point in the torso frame (camera frame until the axes exist). */
  const toTorso = (p: V3): V3 => (torso ? [dot(p, torso.ex), dot(p, torso.ey), dot(p, torso.ez)] : p)

  /** Learn the torso axes slowly from quiet frames, so a tilted camera's pitch is factored out. */
  function learnTorso(w: Joint[], dt: number, seed: boolean): void {
    const ls = w[LM.L_SHOULDER]
    const rs = w[LM.R_SHOULDER]
    const lh = w[23]
    const rh = w[24]
    if (!finite(ls) || !finite(rs)) return
    const shMid = scaleV([ls.x + rs.x, ls.y + rs.y, ls.z + rs.z], 0.5)
    // World landmarks are hip-centred, so the hip midpoint is near the origin even when the hips are off-screen.
    const hipMid: V3 = finite(lh) && finite(rh) ? scaleV([lh.x + rh.x, lh.y + rh.y, lh.z + rh.z], 0.5) : [0, 0, 0]
    const next = axesFrom(sub(v3(rs), v3(ls)), sub(hipMid, shMid))
    if (!next) return
    if (!torso) {
      if (seed) torso = { ...next, ms: 0 }
      return
    }
    torso.ms += dt
    const k = Math.min(1, dt / Math.min(Math.max(torso.ms, 1), cfg.baselineTauMs))
    const blend = (a: V3, b: V3): V3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
    const upd = axesFrom(blend(torso.ex, next.ex), blend(torso.ey, next.ey))
    if (upd) torso = { ...upd, ms: torso.ms }
  }

  function track(h: HandState, f: BodyFrame, midX: number, midY: number, swWorld: number): void {
    const b = f.body
    const w = f.world
    const t = f.t
    const ids = [h.shoulder, h.elbow, h.wrist]
    if (ids.some((i) => !finite(b[i]) || !finite(w[i]) || b[i].visibility < cfg.minVisibility)) {
      untrack(h)
      return
    }
    const theta = angle3(w[h.shoulder], w[h.elbow], w[h.wrist])
    if (theta === null) {
      untrack(h)
      return
    }
    const W = b[h.wrist]
    const WW = w[h.wrist]
    const zReach = toTorso(v3(WW))[2] - toTorso(v3(w[h.shoulder]))[2]
    const s: Sample = {
      t,
      theta,
      relX: W.x - midX,
      relY: W.y - midY,
      inward: -h.side * (W.x - midX),
      below: W.y - b[h.shoulder].y,
      bx: W.x,
      by: W.y,
      wx: WW.x,
      wy: WW.y,
      wz: WW.z,
      zReach,
      zs: zReach / swWorld,
      speed: 0,
      dtheta: 0,
    }
    h.last = s

    // Low confidence: freeze velocity instead of differentiating a guessed joint. A long freeze drops history.
    if (ids.some((i) => b[i].visibility < cfg.velocityMinVisibility)) {
      h.frozenSince ??= t
      h.motion = null
      if (t - h.frozenSince > cfg.freezeMaxMs) {
        h.hist = []
        h.crossT = null
      }
      return
    }
    h.frozenSince = null

    const prev = h.hist[h.hist.length - 1]
    if (prev !== undefined && prev.inward < -cfg.hookMidlineMargin && s.inward >= -cfg.hookMidlineMargin) h.crossT = t
    h.hist.push(s)
    // Keep one sample older than keepMs so a derivative reference always exists.
    while (h.hist.length > 2 && h.hist[1].t <= t - keepMs) h.hist.shift()

    let ref: Sample | undefined
    for (let i = h.hist.length - 2; i >= 0; i--) {
      if (h.hist[i].t <= t - cfg.velocityWindowMs) {
        ref = h.hist[i]
        break
      }
    }
    if (ref === undefined) {
      h.motion = null
    } else {
      // t strictly increases within a history (checked in update), and gaps over maxGapMs clear it,
      // so the step is between velocityWindowMs and maxGapMs at any frame rate.
      const k = 1000 / (t - ref.t)
      const vx = (s.relX - ref.relX) * k
      const vy = (s.relY - ref.relY) * k
      const fwd = -(s.zs - ref.zs) * k
      s.dtheta = num((s.theta - ref.theta) * k)
      h.motion = { dtheta: s.dtheta, vx, vy, fwd, rel: Math.max(Math.hypot(vx, vy), Math.abs(fwd)) }
      const speed2d = Math.hypot(s.bx - ref.bx, s.by - ref.by) * k
      const speed3d = (Math.hypot(s.wx - ref.wx, s.wy - ref.wy, s.wz - ref.wz) * k) / swWorld
      s.speed = num(Math.max(speed2d, speed3d))
    }

    // Spatial retraction hysteresis: the wrist must come back along the punch's line from its furthest point.
    let retracted = true
    if (!h.armed && h.punchStart !== null && h.punchDir !== null) {
      const out = dot(sub(pos(s), h.punchStart), h.punchDir)
      h.punchMaxOut = Math.max(h.punchMaxOut, out)
      retracted = h.punchMaxOut - out >= cfg.retractFraction * Math.max(h.punchMaxOut, cfg.retractMin)
    }
    if (!h.armed && t - h.lastPunchT >= cfg.cooldownMs) {
      if (still(h)) h.stillSince ??= t
      else h.stillSince = null
      const timedOut = h.stillSince !== null && t - h.lastPunchT >= cfg.rearmTimeoutMs
      if (retracted || timedOut) {
        h.armed = true
        h.armedT = t
        h.stillSince = null
      }
    }
  }

  function detect(h: HandState, other: HandState, t: number): Punch | null {
    const m = h.motion
    const s = h.hist[h.hist.length - 1]
    if (!h.armed || m === null || s === undefined || s.t !== t || t - h.lastPunchT < cfg.cooldownMs) return null
    const inward = -h.side * m.vx
    const up = -m.vy
    const r = cfg.dominanceRatio
    // Extension evidence must be newer than this hand's re-arm, so one long extension never fires twice.
    const since = Math.max(t - cfg.straightDthetaWindowMs, h.armedT)
    const extendedSince = (minDtheta: number): boolean => h.hist.some((p) => p.t >= since && p.dtheta > minDtheta)
    const reached =
      s.theta > cfg.straightMinTheta &&
      s.zReach < cfg.straightMaxZReach &&
      (h.guardZ.v === null || s.zReach < h.guardZ.v - cfg.straightMinForward) &&
      extendedSince(cfg.straightMinDtheta)
    // Depth is often under-read for a punch straight at the camera, so a fast forward drive with an opening
    // elbow also counts. Forward speed must beat the 2D speed so raising the guard never reads as a jab.
    const thrust =
      m.fwd > cfg.thrustMinFwd &&
      m.fwd > r * Math.hypot(m.vx, m.vy) &&
      s.theta > cfg.thrustMinTheta &&
      extendedSince(cfg.thrustMinDtheta)
    const straight = reached || thrust
    const lat = cfg.hookMinLateralRatio
    const hook =
      inward > cfg.hookMinSpeed &&
      h.crossT !== null &&
      t - h.crossT <= cfg.hookCrossWindowMs &&
      s.theta > cfg.hookMinTheta &&
      s.theta < cfg.hookMaxTheta &&
      inward > lat * Math.abs(m.vy) &&
      inward > lat * Math.max(0, m.fwd)
    const otherRise = other.motion === null ? 0 : -other.motion.vy
    const startWin = h.hist.filter((p) => p.t >= t - cfg.uppercutStartWindowMs && p.t >= h.armedT)
    const uppercut =
      up > cfg.uppercutMinSpeed &&
      startWin.some((p) => p.below > cfg.uppercutStartBelow) &&
      // A hand rising from the waist is a guard raise, not an uppercut.
      !startWin.some((p) => p.below > cfg.uppercutMaxStartBelow) &&
      up > r * Math.abs(m.vx) &&
      up > r * m.fwd &&
      otherRise <= cfg.uppercutMaxOtherRise * up
    // yaw grows as the right shoulder comes forward and side is +1 for the right hand,
    // so rotation > 0 means this hand's shoulder drove forward from the player's own stance.
    const rotation = h.side * (yaw - (stance.v ?? yaw))
    const rear = h.hand !== lead
    let kind: PunchKind | null = null
    if (uppercut) kind = 'uppercut'
    else if (hook) kind = 'hook'
    else if (straight) {
      kind = rotation > cfg.crossMinYaw || (rear && rotation > cfg.rearCrossMinYaw) ? 'cross' : 'jab'
    }
    if (kind === null) return null
    let peak = 0
    let start: Sample = s
    for (const p of h.hist) {
      if (p.t < t - cfg.peakWindowMs) continue
      if (p.speed > peak) peak = p.speed
      if (p.t < start.t) start = p
    }
    h.armed = false
    h.lastPunchT = t
    h.punchStart = pos(start)
    h.punchDir = unit(sub(pos(s), pos(start)))
    h.punchMaxOut = h.punchDir ? dot(sub(pos(s), pos(start)), h.punchDir) : 0
    h.stillSince = null
    return { kind, hand: h.hand, t, peakVelocity: num(peak), elbowAngle: num(s.theta), source: 'pose' }
  }

  /** Baselines learn only from quiet frames, after detect so a punch on this frame already counts. */
  function learn(f: BodyFrame, dt: number): void {
    const t = f.t
    const allQuiet = hands.every((h) => h.hist.length === 0 || quiet(h, t))
    for (const h of hands) {
      const s = h.hist[h.hist.length - 1]
      if (s !== undefined && s.t === t && quiet(h, t) && s.theta < cfg.rearmTheta) {
        follow(h.guardZ, s.zReach, dt, cfg.baselineTauMs)
      }
    }
    if (stance.v === null) stance.v = yaw
    if (allQuiet) {
      follow(stance, yaw, dt, cfg.baselineTauMs)
      learnTorso(f.world, dt, false)
    }
  }

  function updateGuard(f: BodyFrame): boolean {
    const b = f.body
    const n = b[LM.NOSE]
    if (!finite(n) || n.visibility < cfg.minVisibility) return false
    const radius = cfg.guardMaxNoseDist + (guard ? cfg.hysteresis : 0)
    return hands.every((h) => {
      const s = h.last
      if (s === null || s.t !== f.t) return false
      return Math.hypot(s.bx - n.x, s.by - n.y) < radius && s.below < 0 && s.theta < cfg.guardMaxTheta
    })
  }

  function updateSlip(f: BodyFrame, dt: number): SlipKind | null {
    const n = f.body[LM.NOSE]
    noseX = 0
    duckY = 0
    if (!finite(n) || n.visibility < cfg.minVisibility) {
      slipT = null
      return null
    }
    nose ??= { x: num(f.neutralNose.x), y: num(f.neutralNose.y) }
    noseX = n.x - nose.x
    duckY = n.y - nose.y
    const sideKind: SlipKind = noseX < 0 ? 'left' : 'right'
    const thX = Math.max(1e-6, cfg.slipMinNoseX - (slip === sideKind ? cfg.hysteresis : 0))
    const thY = Math.max(1e-6, cfg.duckMinDrop - (slip === 'duck' ? cfg.hysteresis : 0))
    // Relative excess: how far past its threshold each one is, as a ratio.
    const ex = Math.abs(noseX) / thX
    const ey = duckY / thY
    const kind: SlipKind | null = ex <= 1 && ey <= 1 ? null : ex >= ey ? sideKind : 'duck'
    slipT = kind === null ? null : (slipT ?? f.t)
    // Drift correction only while idle (upright, hands still), so a quick duck is always measured from a
    // true neutral; a slip held a long time re-centres too, so stepping aside never sticks.
    const idle = slipT === null && hands.every((h) => h.motion === null || h.motion.rel < cfg.rearmSpeed)
    if (idle || (slipT !== null && f.t - slipT >= cfg.slipHoldMs)) {
      const k = Math.min(1, dt / cfg.noseTauMs)
      nose.x += noseX * k
      nose.y += duckY * k
    }
    return kind
  }

  function debug(): Record<string, number> {
    const d: Record<string, number> = {}
    for (const h of hands) {
      const p = h.hand === 'left' ? 'l' : 'r'
      const s = h.hist[h.hist.length - 1]
      d[p + 'Theta'] = s?.theta ?? 0
      d[p + 'Dtheta'] = h.motion?.dtheta ?? 0
      d[p + 'ZReach'] = s?.zReach ?? 0
      d[p + 'GuardZ'] = h.guardZ.v ?? 0
      d[p + 'Vx'] = h.motion?.vx ?? 0
      d[p + 'Vy'] = h.motion?.vy ?? 0
      d[p + 'Armed'] = h.armed ? 1 : 0
      d[p + 'Frozen'] = h.frozenSince !== null ? 1 : 0
    }
    d.yaw = yaw - (stance.v ?? yaw)
    d.southpaw = lead === 'right' ? 1 : 0
    d.pitch = torso ? Math.asin(Math.max(-1, Math.min(1, torso.ey[2]))) * DEG : 0
    d.guard = guard ? 1 : 0
    d.noseX = noseX
    d.duckY = duckY
    d.suppressed = lastT !== null && lastT < suppressUntil ? 1 : 0
    for (const k in d) d[k] = num(d[k])
    return d
  }

  return {
    update(f: BodyFrame | null): BoxingActions {
      const punches: Punch[] = []
      if (f === null || f.body.length < 33 || f.world.length < 33 || !Number.isFinite(f.t)) {
        clearHistory()
        guard = false
        slip = null
        slipT = null
        noseX = 0
        duckY = 0
        return { punches, guard, slip, debug: debug() }
      }
      const t = f.t
      if (f.calibration !== calibration) {
        calibration = f.calibration
        lead = calibration.stance === 'southpaw' ? 'right' : 'left'
        clearHistory()
        resetBaselines()
      }
      if (lastT !== null && (t <= lastT || t - lastT > cfg.maxGapMs)) clearHistory()
      const dt = lastT === null ? 0 : t - lastT
      lastT = t
      checkSwitch(t, f.scale)
      const suppressed = t < suppressUntil
      const b = f.body
      const w = f.world
      const shouldersOk = [LM.L_SHOULDER, LM.R_SHOULDER].every(
        (i) => finite(b[i]) && finite(w[i]) && b[i].visibility >= cfg.minVisibility,
      )
      if (shouldersOk) {
        if (!torso) learnTorso(w, 0, true)
        const midX = (b[LM.L_SHOULDER].x + b[LM.R_SHOULDER].x) / 2
        const midY = (b[LM.L_SHOULDER].y + b[LM.R_SHOULDER].y) / 2
        // The contract says never 0; the floor only guards against broken input.
        const swWorld = Math.max(num(f.calibration.shoulderWidthWorld), 0.05)
        const ls = toTorso(v3(w[LM.L_SHOULDER]))
        const rs = toTorso(v3(w[LM.R_SHOULDER]))
        yaw = Math.atan2(ls[2] - rs[2], Math.max(1e-6, rs[0] - ls[0])) * DEG
        for (const h of hands) track(h, f, midX, midY, swWorld)
        if (!suppressed) {
          const [l, r] = hands
          const pl = detect(l, r, t)
          const pr = detect(r, l, t)
          if (pl) punches.push(pl)
          if (pr) punches.push(pr)
          learn(f, dt)
        }
      } else {
        for (const h of hands) untrack(h)
        yaw = 0
      }
      guard = updateGuard(f)
      if (suppressed) {
        slip = null
        slipT = null
        noseX = 0
        duckY = 0
      } else {
        slip = updateSlip(f, dt)
      }
      return { punches, guard, slip, debug: debug() }
    },

    reset(): void {
      clearHistory()
      for (const h of hands) {
        h.armed = true
        h.lastPunchT = -Infinity
        h.armedT = -Infinity
        h.punchStart = null
        h.punchDir = null
        h.punchMaxOut = 0
        h.stillSince = null
      }
      guard = false
      slip = null
      slipT = null
      suppressUntil = -Infinity
      noseX = 0
      duckY = 0
    },
  }
}
