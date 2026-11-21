// Boxing motion detector (research doc section 3, Sport 1 "Motion Detection Logic").
// Pure: no DOM, time comes only from BodyFrame.t. 2D values are in body space (shoulder widths, SW,
// y down, mirror view), 3D values in world metres. Elbow angles use world space.
// Cross twist, straight reach and slips are measured from slow personal baselines (stance twist, each
// hand's guard, nose position), so a bladed stance, a forward guard or sideways drift never reads as an action.
import type { OneEuroParams } from '../../pose/oneEuro.ts'
import { LM } from '../../pose/types.ts'
import type { BodyFrame, Calibration, Hand, Joint } from '../../pose/types.ts'
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
  /** ms. A hand is quiet (baselines learn from it) while it moves slower than rearmSpeed and its last punch is at least this old. */
  quietMs: number
  /** ms. Stance twist and guard reach baselines: running mean of quiet frames at first, then an EMA with this time constant. */
  baselineTauMs: number
  /** deg/s. Straight: minimum elbow extension speed d(theta)/dt... */
  straightMinDtheta: number
  /** ms. ...reached within this window, so at 15 fps a punch that straightens between two frames still counts. */
  straightDthetaWindowMs: number
  /** deg. Straight: minimum elbow angle (180 = straight arm). */
  straightMinTheta: number
  /** m. Straight: world z_wrist - z_shoulder must be below this (negative = wrist in front of the shoulder)... */
  straightMaxZReach: number
  /** m. ...and at least this far in front of that hand's guard baseline (its quiet z_wrist - z_shoulder with a bent arm). */
  straightMinForward: number
  /** m. A straight is a cross when the punching side's shoulder has come forward by more than this (z_11 - z_12 against the stance baseline), else a jab. */
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
  /** SW. Slip: |nose.x - baseline.x| above this. */
  slipMinNoseX: number
  /** SW. Duck: nose.y - baseline.y above this. */
  duckMinDrop: number
  /** ms. The nose baseline starts at the calibrated neutral nose and follows the nose with this EMA time constant (about a 4 s average) while upright... */
  noseTauMs: number
  /** ms. ...and again once a slip or duck has been held this long, so stepping aside never leaves a permanent slip. */
  slipHoldMs: number
  /** SW. Guard, slip and duck switch off only once their distance is this far back past the threshold. */
  hysteresis: number
  /** Ratio. Tracking switch (passer-by or a bad fit): the live shoulder width (BodyFrame.scale) changes by more than this... */
  switchMinJump: number
  /** ms. ...within this window... */
  switchWindowMs: number
  /** ms. ...which clears motion history and suppresses punches and slips for this long. */
  switchSuppressMs: number
}

export const DEFAULT_BOXING_CONFIG: BoxingDetectorConfig = {
  minVisibility: 0.5,
  maxGapMs: 250,
  velocityWindowMs: 55,
  peakWindowMs: 150,
  cooldownMs: 220,
  rearmTheta: 125,
  rearmSpeed: 1,
  quietMs: 400,
  baselineTauMs: 3000,
  straightMinDtheta: 280,
  straightDthetaWindowMs: 80,
  straightMinTheta: 135,
  straightMaxZReach: -0.18,
  straightMinForward: 0.1,
  crossMinTwist: 0.1,
  hookMinSpeed: 2.8,
  hookMinTheta: 70,
  hookMaxTheta: 130,
  hookMidlineMargin: 0.1,
  hookCrossWindowMs: 120,
  uppercutMinSpeed: 3,
  uppercutStartBelow: 0,
  uppercutStartWindowMs: 250,
  uppercutMaxOtherRise: 0.5,
  dominanceRatio: 1,
  guardMaxNoseDist: 0.45,
  guardMaxTheta: 140,
  slipMinNoseX: 0.35,
  duckMinDrop: 0.25,
  noseTauMs: 2000,
  slipHoldMs: 1000,
  hysteresis: 0.05,
  switchMinJump: 0.35,
  switchWindowMs: 100,
  switchSuppressMs: 300,
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
  motion: Motion | null
  armed: boolean
  lastPunchT: number
  lastStraight: boolean
  crossT: number | null
  /** Quiet zReach with a bent arm: where this hand rests in its guard. */
  guardZ: Baseline
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
    motion: null,
    armed: true,
    lastPunchT: -Infinity,
    lastStraight: false,
    crossT: null,
    guardZ: newBaseline(),
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
  /** World z_11 - z_12, m: grows as the right shoulder comes forward. */
  let twist = 0
  /** Quiet twist: the player's own stance, square or bladed. */
  let stance = newBaseline()
  /** Nose baseline in body space, null until seeded from the calibration's neutral nose. */
  let nose: { x: number; y: number } | null = null
  let calibration: Calibration | null = null
  /** Live shoulder widths within switchWindowMs, plus one older sample. */
  let scales: Array<{ t: number; s: number }> = []
  let suppressUntil = -Infinity
  let noseX = 0
  let duckY = 0

  function untrack(h: HandState): void {
    h.hist = []
    h.motion = null
    h.crossT = null
  }

  /** Null frames and gaps: no derivatives across them. Cooldowns, arming and baselines survive. */
  function clearHistory(): void {
    for (const h of hands) untrack(h)
    lastT = null
    twist = 0
    scales = []
  }

  /** A new calibration is a new body space and maybe a new player: learn everything again. */
  function resetBaselines(): void {
    stance = newBaseline()
    for (const h of hands) h.guardZ = newBaseline()
    nose = null
  }

  const quiet = (h: HandState, t: number): boolean =>
    h.motion !== null && h.motion.rel < cfg.rearmSpeed && t - h.lastPunchT >= cfg.quietMs

  /** A sudden change of shoulder width is a different body: no derivatives across it, no actions for a moment. */
  function checkSwitch(t: number, scale: number): void {
    if (!(Number.isFinite(scale) && scale > 0)) return
    scales.push({ t, s: scale })
    while (scales.length > 2 && scales[1].t <= t - cfg.switchWindowMs) scales.shift()
    let lo = Infinity
    let hi = 0
    for (const p of scales) {
      lo = Math.min(lo, p.s)
      hi = Math.max(hi, p.s)
    }
    if (hi <= lo * (1 + cfg.switchMinJump)) return
    for (const h of hands) untrack(h)
    scales = [{ t, s: scale }]
    suppressUntil = t + cfg.switchSuppressMs
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
      (h.guardZ.v === null || s.zReach < h.guardZ.v - cfg.straightMinForward) &&
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
    // Twist grows as the right shoulder comes forward and side is +1 for the right hand,
    // so rotation > 0 means this hand's shoulder drove forward from the player's own stance.
    const rotation = h.side * (twist - (stance.v ?? twist))
    // Dominant motion: vertical -> uppercut, horizontal with a bent arm -> hook, else straight.
    // Hook and uppercut already dominate their other axes; hook (theta < 130) and straight (theta > 135) never both fire.
    let kind: PunchKind | null = null
    if (uppercut) kind = 'uppercut'
    else if (hook) kind = 'hook'
    else if (straight) kind = rotation > cfg.crossMinTwist ? 'cross' : 'jab'
    if (kind === null) return null
    h.armed = false
    h.lastPunchT = t
    h.lastStraight = kind === 'jab' || kind === 'cross'
    let peak = 0
    for (const p of h.hist) if (p.t >= t - cfg.peakWindowMs && p.speed > peak) peak = p.speed
    return { kind, hand: h.hand, t, peakVelocity: num(peak), elbowAngle: num(s.theta), source: 'pose' }
  }

  /** Baselines learn only from quiet frames, after detect so a punch on this frame already counts. */
  function learn(t: number, dt: number): void {
    for (const h of hands) {
      const s = h.hist[h.hist.length - 1]
      if (s !== undefined && s.t === t && quiet(h, t) && s.theta < cfg.rearmTheta) {
        follow(h.guardZ, s.zReach, dt, cfg.baselineTauMs)
      }
    }
    if (stance.v === null) stance.v = twist
    if (hands.every((h) => h.hist.length === 0 || quiet(h, t))) follow(stance, twist, dt, cfg.baselineTauMs)
  }

  function updateGuard(f: BodyFrame): boolean {
    const b = f.body
    const n = b[LM.NOSE]
    if (!finite(n) || n.visibility < cfg.minVisibility) return false
    const radius = cfg.guardMaxNoseDist + (guard ? cfg.hysteresis : 0)
    return hands.every((h) => {
      const s = h.hist[h.hist.length - 1]
      if (s === undefined || s.t !== f.t) return false
      const W = b[h.wrist]
      return Math.hypot(W.x - n.x, W.y - n.y) < radius && s.below < 0 && s.theta < cfg.guardMaxTheta
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
    // Re-centre slowly so drift is absorbed; a real slip is a quick departure from here.
    if (slipT === null || f.t - slipT >= cfg.slipHoldMs) {
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
    }
    d.twist = twist - (stance.v ?? twist)
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
        const midX = (b[LM.L_SHOULDER].x + b[LM.R_SHOULDER].x) / 2
        const midY = (b[LM.L_SHOULDER].y + b[LM.R_SHOULDER].y) / 2
        // The contract says never 0; the floor only guards against broken input.
        const swWorld = Math.max(num(f.calibration.shoulderWidthWorld), 0.05)
        twist = w[LM.L_SHOULDER].z - w[LM.R_SHOULDER].z
        for (const h of hands) track(h, f, midX, midY, swWorld)
        if (!suppressed) {
          const [l, r] = hands
          const pl = detect(l, r, t)
          const pr = detect(r, l, t)
          if (pl) punches.push(pl)
          if (pr) punches.push(pr)
          learn(t, dt)
        }
      } else {
        for (const h of hands) untrack(h)
        twist = 0
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
        h.lastStraight = false
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
