// Boxing motion detector (research doc section 3, Sport 1 "Motion Detection Logic").
// Pure: no DOM, time comes only from BodyFrame.t. 2D values are in body space (shoulder widths, SW,
// y down, mirror view), 3D values in world metres. Elbow angles use world space.
import type { OneEuroParams } from '../../pose/oneEuro.ts'
import { LM } from '../../pose/types.ts'
import type { BodyFrame, Hand, Joint } from '../../pose/types.ts'
import type { BoxingActions, BoxingDetector, Punch, PunchKind, SlipKind } from './types.ts'

export interface BoxingDetectorConfig {
  /** 0 to 1. A hand needs its shoulder, elbow and wrist (and both shoulders) at least this visible. Guard and slip need the nose too. */
  minVisibility: number
  /** ms. A longer gap between frames, or a t that does not increase, clears all motion history. */
  maxGapMs: number
  /** ms. Derivatives compare against the newest sample at least this old (span about 55 to 80 ms at 15 to 60 fps). */
  velocityWindowMs: number
  /** ms. Punch.peakVelocity is the highest wrist speed within this window. */
  peakWindowMs: number
  /** ms. Minimum time between two punches of the same hand. */
  cooldownMs: number
  /** deg. After the cooldown, a hand whose last punch was straight re-arms once its elbow angle is below this... */
  rearmTheta: number
  /** SW/s. ...or (any punch kind) once its wrist moves slower than this relative to the torso. */
  rearmSpeed: number
  /** deg/s. Straight: minimum elbow extension speed d(theta)/dt... */
  straightMinDtheta: number
  /** ms. ...reached within this window, so at 15 fps a punch that straightens between two frames still counts. */
  straightDthetaWindowMs: number
  /** deg. Straight: minimum elbow angle (180 = straight arm). */
  straightMinTheta: number
  /** m. Straight: world z_wrist - z_shoulder must be below this (negative = wrist in front of the shoulder). */
  straightMaxZReach: number
  /** m. A straight is a cross when the shoulder twist |z_11 - z_12| is above this, else a jab. */
  crossMinTwist: number
  /** SW/s. Hook: minimum inward lateral wrist speed. */
  hookMinSpeed: number
  /** deg. Hook: elbow angle must be above this... */
  hookMinTheta: number
  /** deg. ...and below this. */
  hookMaxTheta: number
  /** SW. Hook: the wrist counts as crossing the torso midline once it is within this distance of it, coming from its own side. */
  hookMidlineMargin: number
  /** ms. Hook: the midline crossing must be at most this old. */
  hookCrossWindowMs: number
  /** SW/s. Uppercut: minimum upward wrist speed (-v_y). */
  uppercutMinSpeed: number
  /** SW. Uppercut: the wrist must have been more than this far below its shoulder line... */
  uppercutStartBelow: number
  /** ms. ...at some point within this window (the start of the motion). */
  uppercutStartWindowMs: number
  /** Ratio. No uppercut while the other wrist rises faster than this times this wrist's upward speed (both hands coming up to guard). */
  uppercutMaxOtherRise: number
  /** Ratio. Dominant motion: a hook needs inward speed above this times |v_y| and the forward speed; an uppercut needs upward speed above this times |v_x| and the forward speed. */
  dominanceRatio: number
  /** SW. Guard: both wrists within this 2D distance of the nose (and above their shoulders)... */
  guardMaxNoseDist: number
  /** deg. ...and both elbows bent below this, so a straight arm in front of the face is a punch, not a guard. */
  guardMaxTheta: number
  /** SW. Slip: |nose.x| above this (body space, from the calibrated torso centre). */
  slipMinNoseX: number
  /** SW. Duck: nose.y - neutralNose.y above this. */
  duckMinDrop: number
  /** SW. Guard, slip and duck switch off only once their distance is this far back past the threshold. */
  hysteresis: number
}

export const DEFAULT_BOXING_CONFIG: BoxingDetectorConfig = {
  minVisibility: 0.5,
  maxGapMs: 250,
  velocityWindowMs: 55,
  peakWindowMs: 150,
  cooldownMs: 220,
  rearmTheta: 125,
  rearmSpeed: 1,
  straightMinDtheta: 280,
  straightDthetaWindowMs: 80,
  straightMinTheta: 140,
  straightMaxZReach: -0.18,
  crossMinTwist: 0.12,
  hookMinSpeed: 2.2,
  hookMinTheta: 70,
  hookMaxTheta: 130,
  hookMidlineMargin: 0.1,
  hookCrossWindowMs: 120,
  uppercutMinSpeed: 2,
  uppercutStartBelow: 0,
  uppercutStartWindowMs: 250,
  uppercutMaxOtherRise: 0.5,
  dominanceRatio: 1,
  guardMaxNoseDist: 0.45,
  guardMaxTheta: 140,
  slipMinNoseX: 0.35,
  duckMinDrop: 0.25,
  hysteresis: 0.05,
}

/** 1-euro filter tuning for boxing (research doc: minCutoff 1.5 Hz, beta 0.08, dCutoff 1.0 Hz). */
export const BOXING_FILTER: OneEuroParams = { minCutoff: 1.5, beta: 0.08, dCutoff: 1.0 }

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
  /** World wrist, metres. */
  wx: number
  wy: number
  wz: number
  /** World z_wrist - z_shoulder, metres. */
  zReach: number
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
  /** Wrist speed relative to the torso, SW/s, for re-arming. */
  rel: number
}

interface HandState {
  readonly hand: Hand
  /** -1: own side is screen left (player's left in the mirror view), +1: screen right. */
  readonly side: number
  readonly shoulder: number
  readonly elbow: number
  readonly wrist: number
  hist: Sample[]
  motion: Motion | null
  armed: boolean
  lastPunchT: number
  lastStraight: boolean
  crossT: number | null
}

const DEG = 180 / Math.PI

function newHand(hand: Hand): HandState {
  const left = hand === 'left'
  return {
    hand,
    side: left ? -1 : 1,
    shoulder: left ? LM.L_SHOULDER : LM.R_SHOULDER,
    elbow: left ? LM.L_ELBOW : LM.R_ELBOW,
    wrist: left ? LM.L_WRIST : LM.R_WRIST,
    hist: [],
    motion: null,
    armed: true,
    lastPunchT: -Infinity,
    lastStraight: false,
    crossT: null,
  }
}

const finite = (j: Joint | undefined): j is Joint =>
  j !== undefined && Number.isFinite(j.x) && Number.isFinite(j.y) && Number.isFinite(j.z)

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

export function createBoxingDetector(config: Partial<BoxingDetectorConfig> = {}): BoxingDetector {
  const cfg: BoxingDetectorConfig = { ...DEFAULT_BOXING_CONFIG, ...config }
  const keepMs = Math.max(cfg.velocityWindowMs, cfg.peakWindowMs, cfg.uppercutStartWindowMs, cfg.hookCrossWindowMs)
  const hands: [HandState, HandState] = [newHand('left'), newHand('right')]
  let lastT: number | null = null
  let guard = false
  let slip: SlipKind | null = null
  let twist = 0
  let noseX = 0
  let duckY = 0

  function untrack(h: HandState): void {
    h.hist = []
    h.motion = null
    h.crossT = null
  }

  /** Null frames and gaps: no derivatives across them. Cooldowns and arming survive. */
  function clearHistory(): void {
    for (const h of hands) untrack(h)
    lastT = null
    twist = 0
  }

  function track(h: HandState, f: BodyFrame, midX: number, midY: number, swWorld: number): void {
    const b = f.body
    const w = f.world
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
    const t = f.t
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
      zReach: WW.z - w[h.shoulder].z,
      speed: 0,
      dtheta: 0,
    }
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
      // t strictly increases within a history (checked in update), so dt > 0.
      const k = 1000 / (t - ref.t)
      const vx = (s.relX - ref.relX) * k
      const vy = (s.relY - ref.relY) * k
      const fwd = (-(s.zReach - ref.zReach) * k) / swWorld
      s.dtheta = num((s.theta - ref.theta) * k)
      h.motion = { dtheta: s.dtheta, vx, vy, fwd, rel: Math.max(Math.hypot(vx, vy), Math.abs(fwd)) }
      const speed2d = Math.hypot(s.bx - ref.bx, s.by - ref.by) * k
      const speed3d = (Math.hypot(s.wx - ref.wx, s.wy - ref.wy, s.wz - ref.wz) * k) / swWorld
      s.speed = num(Math.max(speed2d, speed3d))
    }

    if (!h.armed && t - h.lastPunchT >= cfg.cooldownMs) {
      const slow = h.motion !== null && h.motion.rel < cfg.rearmSpeed
      if (slow || (h.lastStraight && theta < cfg.rearmTheta)) h.armed = true
    }
  }

  function detect(h: HandState, other: HandState, t: number): Punch | null {
    const m = h.motion
    const s = h.hist[h.hist.length - 1]
    if (!h.armed || m === null || s === undefined || t - h.lastPunchT < cfg.cooldownMs) return null
    const inward = -h.side * m.vx
    const up = -m.vy
    const r = cfg.dominanceRatio
    const straight =
      s.theta > cfg.straightMinTheta &&
      s.zReach < cfg.straightMaxZReach &&
      h.hist.some((p) => p.t >= t - cfg.straightDthetaWindowMs && p.dtheta > cfg.straightMinDtheta)
    const hook =
      inward > cfg.hookMinSpeed &&
      h.crossT !== null &&
      t - h.crossT <= cfg.hookCrossWindowMs &&
      s.theta > cfg.hookMinTheta &&
      s.theta < cfg.hookMaxTheta &&
      inward > r * Math.abs(m.vy) &&
      inward > r * m.fwd
    const otherRise = other.motion === null ? 0 : -other.motion.vy
    const uppercut =
      up > cfg.uppercutMinSpeed &&
      h.hist.some((p) => p.t >= t - cfg.uppercutStartWindowMs && p.below > cfg.uppercutStartBelow) &&
      up > r * Math.abs(m.vx) &&
      up > r * m.fwd &&
      otherRise <= cfg.uppercutMaxOtherRise * up
    // Dominant motion: vertical -> uppercut, horizontal with a bent arm -> hook, else straight.
    // Hook and uppercut already dominate their other axes; hook (theta < 130) and straight (theta > 140) never both fire.
    let kind: PunchKind | null = null
    if (uppercut) kind = 'uppercut'
    else if (hook) kind = 'hook'
    else if (straight) kind = twist > cfg.crossMinTwist ? 'cross' : 'jab'
    if (kind === null) return null
    h.armed = false
    h.lastPunchT = t
    h.lastStraight = kind === 'jab' || kind === 'cross'
    let peak = 0
    for (const p of h.hist) if (p.t >= t - cfg.peakWindowMs && p.speed > peak) peak = p.speed
    return { kind, hand: h.hand, t, peakVelocity: num(peak), elbowAngle: num(s.theta), source: 'pose' }
  }

  function updateGuard(f: BodyFrame): boolean {
    const b = f.body
    const nose = b[LM.NOSE]
    if (!finite(nose) || nose.visibility < cfg.minVisibility) return false
    const radius = cfg.guardMaxNoseDist + (guard ? cfg.hysteresis : 0)
    return hands.every((h) => {
      const s = h.hist[h.hist.length - 1]
      if (s === undefined || s.t !== f.t) return false
      const W = b[h.wrist]
      return Math.hypot(W.x - nose.x, W.y - nose.y) < radius && s.below < 0 && s.theta < cfg.guardMaxTheta
    })
  }

  function updateSlip(f: BodyFrame): SlipKind | null {
    const nose = f.body[LM.NOSE]
    if (!finite(nose) || nose.visibility < cfg.minVisibility) return null
    noseX = nose.x
    duckY = nose.y - f.neutralNose.y
    const sideKind: SlipKind = noseX < 0 ? 'left' : 'right'
    const thX = Math.max(1e-6, cfg.slipMinNoseX - (slip === sideKind ? cfg.hysteresis : 0))
    const thY = Math.max(1e-6, cfg.duckMinDrop - (slip === 'duck' ? cfg.hysteresis : 0))
    // Relative excess: how far past its threshold each one is, as a ratio.
    const ex = Math.abs(noseX) / thX
    const ey = duckY / thY
    if (ex <= 1 && ey <= 1) return null
    return ex >= ey ? sideKind : 'duck'
  }

  function debug(): Record<string, number> {
    const d: Record<string, number> = {}
    for (const h of hands) {
      const p = h.hand === 'left' ? 'l' : 'r'
      const s = h.hist[h.hist.length - 1]
      d[p + 'Theta'] = s?.theta ?? 0
      d[p + 'Dtheta'] = h.motion?.dtheta ?? 0
      d[p + 'ZReach'] = s?.zReach ?? 0
      d[p + 'Vx'] = h.motion?.vx ?? 0
      d[p + 'Vy'] = h.motion?.vy ?? 0
      d[p + 'Armed'] = h.armed ? 1 : 0
    }
    d.twist = twist
    d.guard = guard ? 1 : 0
    d.noseX = noseX
    d.duckY = duckY
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
        noseX = 0
        duckY = 0
        return { punches, guard, slip, debug: debug() }
      }
      const t = f.t
      if (lastT !== null && (t <= lastT || t - lastT > cfg.maxGapMs)) clearHistory()
      lastT = t
      const b = f.body
      const w = f.world
      const shouldersOk = [LM.L_SHOULDER, LM.R_SHOULDER].every(
        (i) => finite(b[i]) && finite(w[i]) && b[i].visibility >= cfg.minVisibility,
      )
      if (shouldersOk) {
        const midX = (b[LM.L_SHOULDER].x + b[LM.R_SHOULDER].x) / 2
        const midY = (b[LM.L_SHOULDER].y + b[LM.R_SHOULDER].y) / 2
        // The contract says never 0; the floor only guards against broken input.
        const swWorld = Math.max(f.calibration.shoulderWidthWorld, 0.05)
        twist = Math.abs(w[LM.L_SHOULDER].z - w[LM.R_SHOULDER].z)
        for (const h of hands) track(h, f, midX, midY, swWorld)
        const [l, r] = hands
        const pl = detect(l, r, t)
        const pr = detect(r, l, t)
        if (pl) punches.push(pl)
        if (pr) punches.push(pr)
      } else {
        for (const h of hands) untrack(h)
        twist = 0
      }
      guard = updateGuard(f)
      slip = updateSlip(f)
      return { punches, guard, slip, debug: debug() }
    },

    reset(): void {
      clearHistory()
      for (const h of hands) {
        h.armed = true
        h.lastPunchT = -Infinity
        h.lastStraight = false
      }
      guard = false
      slip = null
      noseX = 0
      duckY = 0
    },
  }
}
