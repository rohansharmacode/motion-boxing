// Aero Bow draw and release detector (research doc section 3, Sport 3 "Archery").
// Pure: no DOM, time comes only from BodyFrame.t. 2D values are body space (shoulder widths, SW, x screen
// right, y down, mirror view), taken relative to the live shoulder midpoint and divided by BodyFrame.scale,
// so whole-body sway and stepping closer change nothing. Elbow angles use world space.
//
// Flow: idle -> drawing (tension above 0.15, bow hand locked) -> armed (tension > ARM_TENSION for
// ARM_HOLD_MS) -> release on a fast snap away from the bow or a fast drop of the draw hand, but only once
// the draw hand has held still at full draw (settled, pulled back from its closest approach to the bow hand),
// with the bow arm still. Low tension for 300 ms is a let-down.
import { OneEuroFilter } from '../../pose/oneEuro.ts'
import type { OneEuroParams } from '../../pose/oneEuro.ts'
import { LM } from '../../pose/types.ts'
import type { BodyFrame, Hand, Joint } from '../../pose/types.ts'
import { ARM_HOLD_MS, ARM_TENSION, SWAY_WINDOW_MS } from './types.ts'
import type { ArcheryDetector, DrawPhase, DrawSample, ReleaseInfo, ReleaseTrigger, Vec2 } from './types.ts'

/**
 * Tracker smoothing for archery, for createBodyTracker. Lighter than goalkeeper's (1.2 Hz, beta 0.12): less
 * lag on the release snap, and the tracked wrists stay close to raw so they can be the "raw" side of the
 * sway measurement. Units are body.ts's (pixels of a 480 px tall frame).
 */
export const ARCHERY_TRACKER_FILTER: OneEuroParams = { minCutoff: 2.0, beta: 0.15, dCutoff: 1.5 }

/** mm. Sway at or below this scores 100 (about the landmark noise floor at 1 to 2 m). */
const STEADY_MM = 3
/** mm. Sway at or above this scores 0. */
const SHAKY_MM = 30

/** Aim stability 0..100 from RMS bow-wrist sway: 100 at <= 3 mm, linear down to 0 at >= 30 mm. NaN scores 0. */
export function stabilityScore(rmsSwayMm: number): number {
  if (Number.isNaN(rmsSwayMm)) return 0
  const u = (rmsSwayMm - STEADY_MM) / (SHAKY_MM - STEADY_MM)
  return 100 * (1 - Math.min(1, Math.max(0, u)))
}

// ---- bow-wrist dual-regime filter (pixel units, like body.ts, so the doc's beta means what it says) ----
const RELAXED_FILTER: OneEuroParams = { minCutoff: 1.5, beta: 0.05, dCutoff: 1.0 }
/** Doc: tighten to 0.6 Hz, beta 0.02 once drawn for a calm reticle. */
const TIGHT_FILTER: OneEuroParams = { minCutoff: 0.6, beta: 0.02, dCutoff: 1.0 }
const FILTER_HEIGHT_PX = 480
/** A longer gap restarts the bow filters instead of easing across it, ms. */
const FILTER_RESET_GAP_MS = 250

// ---- tracking ----
/** Shoulders and wrists need visibility above this. */
const MIN_VISIBILITY = 0.5
/** Elbow angles are only trusted with the elbow at least this visible. */
const ELBOW_MIN_VISIBILITY = 0.3
/** Tracking lost (null or untracked frames) for longer than this drops the draw, ms. */
const LOST_MS = 400
/** Frame interval assumed before two frames have been seen (also times null frames), ms. */
const DEFAULT_DT_MS = 1000 / 30
const MIN_SCALE = 0.2

// ---- handedness ----
/** deg. Elbow above this = straight bow arm. */
const BOW_MIN_DEG = 145
/** deg. Elbow below this = bent draw arm. */
const DRAW_MAX_DEG = 100
/** SW. Geometry fallback: the bow wrist is at least this much further out from the torso centre. */
const GEOMETRY_MARGIN_SW = 0.25
/** Frames of agreeing evidence to change the idle guess, or to correct the lock while still drawing. */
const HAND_VOTES = 3
/** Tie-break before any draw was armed (most players hold the bow in the left hand). */
const DEFAULT_BOW_HAND: Hand = 'left'

// ---- tension and phases ----
const TENSION_MIN_SW = 0.5
const TENSION_MAX_SW = 1.6
const DRAW_START_TENSION = 0.15
/** After a release, reset or lost tracking, a new draw needs the hands back below this first. */
const RECOVER_TENSION = 0.35
const LETDOWN_TENSION = 0.3
const LETDOWN_MS = 300
/** SW. A wrist further than this below the shoulder line means arms down: tension reads 0, no draw. */
const DRAW_MAX_DROP_SW = 1.2
/**
 * SW. Once the bow hand is locked, a draw wrist further than this above the shoulder line is a hand on the
 * head, not an anchor (cheek or chin sits about 0.3 to 0.5 SW up): tension reads 0, no draw. The bow wrist is
 * not limited, so a bow arm aimed upward keeps its tension.
 */
const DRAW_MAX_RISE_SW = 0.8
/**
 * SW. A hold only counts once the draw hand has come back this far from its closest approach to the bow hand
 * in this draw, so a pause while still reaching across (wrists about 1.4 SW apart, already above ARM_TENSION)
 * followed by the pull is not a hold plus a snap.
 */
const PULLBACK_SW = 0.4
/** SW. A hand gap this wide counts as pulled back anyway (a draw hand raised straight to the chin). */
const FULL_DRAW_GAP_SW = 1.9

// ---- velocity and release ----
/**
 * ms. Velocity is a least-squares slope over this trailing window (3 samples at 25 to 30 fps). After a skipped
 * frame, or below 25 fps, older samples (up to HISTORY_GAP_MS back) are taken until the span reaches
 * VEL_MIN_SPAN_MS, so one 66 ms gap still yields a velocity.
 */
const VEL_WINDOW_MS = 80
/** ms. Timestamp jitter allowed at the window edge. */
const VEL_SLACK_MS = 5
/** ms. A velocity needs history spanning at least this. */
const VEL_MIN_SPAN_MS = 40
/** ms. A longer gap restarts the wrist history. */
const HISTORY_GAP_MS = 150
const HISTORY_KEEP_MS = 200
/** SW/s. A single-frame jump faster than this is a landmark glitch: the history restarts. */
const TELEPORT_SPEED = 12
/** SW/s. Draw hand slower than this (at tension > ARM_TENSION) counts as holding. */
const SETTLE_SPEED = 0.8
/** ms. Hold needed before a release counts, so a draw still pulling past ARM_TENSION never fires. */
const SETTLE_MS = 150
/** ms. The trigger must come within this of the end of the hold. */
const RELEASE_WINDOW_MS = 250
/** SW/s. Snap: draw-hand speed, mostly away from the bow hand. */
const SNAP_SPEED = 1.8
/** SW/s. Drop: downward draw-hand speed. */
const DROP_SPEED = 1.5
/** cos 60 deg. A motion counts as "away", "toward" or "down" within 60 degrees of that direction. */
const DIR_COS = 0.5
/** A drop does not count while the bow wrist falls faster than this times the draw wrist (arms lowering). */
const BOW_FALL_RATIO = 0.6
/** ms. The trigger must hold on frames spanning at least this (two frames at 30 fps), so one glitch cannot fire. */
const CONFIRM_MS = 25
/**
 * ms. Frame interval above which (below about 20 fps) a quick snap spans a single fast frame. There the next
 * frame confirms the trigger without being fast itself, as long as the draw hand is still LOW_FPS_CONFIRM_SW
 * past its held position in the trigger direction (a landmark glitch snaps back, a release does not).
 */
const LOW_FPS_DT_MS = 50
const LOW_FPS_CONFIRM_SW = 0.15
/**
 * The bow arm must stay put while the string goes: a trigger does not fire while the bow wrist, averaged over
 * the trigger frames, moves faster than this times the draw wrist (both arms lowering or swinging) and faster
 * than BOW_STILL_MIN_SPEED. A real snap measures under about 0.4 even with a shaky bow arm, lowering both
 * arms about 0.6 to 1.1.
 */
const BOW_STILL_RATIO = 0.5
/** SW/s. Bow wrist speed always allowed on a trigger frame (tremor and landmark noise). */
const BOW_STILL_MIN_SPEED = 0.6
/**
 * ms. Null or untracked frames up to this long keep the settled hold, so one dropped frame just before the
 * snap does not swallow the release. Longer gaps clear it (the hold is rebuilt once tracking is back).
 */
const HOLD_GRACE_MS = 150
/** ms. Release tension and aim are sampled this long before the release motion started. */
const PRE_RELEASE_MS = 100
const RING_MS = 1500

interface Rel {
  t: number
  x: number
  y: number
}

interface WristState {
  readonly hand: Hand
  readonly shoulder: number
  readonly elbow: number
  readonly wrist: number
  /** Wrist relative to the live shoulder midpoint, live SW, y down. Newest last. */
  hist: Rel[]
  /** Slope of hist, live SW/s, y down. null without enough clean history. */
  vel: Vec2 | null
  /** Newest hist position. */
  rel: Vec2
  /** The newest sample was a glitch jump and restarted hist. */
  teleported: boolean
  /** 3D elbow angle, deg. NaN when unknown. */
  angle: number
  relaxed: [OneEuroFilter, OneEuroFilter]
  tight: [OneEuroFilter, OneEuroFilter]
  filterT: number | null
  /** Filter outputs, calibrated body space SW. */
  relaxedPos: Vec2
  tightPos: Vec2
  /** |raw - tight|^2 this frame, live SW^2. */
  resid2: number
}

interface Verdict {
  hand: Hand
  how: 'angle' | 'geometry'
}

/** Per tracked frame, for the pre-release lookback. */
interface Snapshot {
  t: number
  tension: number
  ax: number
  ay: number
}

interface SwaySample {
  t: number
  /** Squared residuals of the left and right wrists, live SW^2. */
  l: number
  r: number
}

const DEG = 180 / Math.PI

function newWrist(hand: Hand): WristState {
  const left = hand === 'left'
  return {
    hand,
    shoulder: left ? LM.L_SHOULDER : LM.R_SHOULDER,
    elbow: left ? LM.L_ELBOW : LM.R_ELBOW,
    wrist: left ? LM.L_WRIST : LM.R_WRIST,
    hist: [],
    vel: null,
    rel: { x: 0, y: 0 },
    teleported: false,
    angle: NaN,
    relaxed: [new OneEuroFilter(RELAXED_FILTER), new OneEuroFilter(RELAXED_FILTER)],
    tight: [new OneEuroFilter(TIGHT_FILTER), new OneEuroFilter(TIGHT_FILTER)],
    filterT: null,
    relaxedPos: { x: 0, y: 0 },
    tightPos: { x: 0, y: 0 },
    resid2: 0,
  }
}

const finite = (j: Joint | undefined): j is Joint =>
  j !== undefined && Number.isFinite(j.x) && Number.isFinite(j.y) && Number.isFinite(j.z)

const usable = (j: Joint | undefined): boolean => finite(j) && j.visibility > MIN_VISIBILITY

const num = (v: number): number => (Number.isFinite(v) ? v : 0)

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

const otherHand = (h: Hand): Hand => (h === 'left' ? 'right' : 'left')

/** Angle at b between a and c in 3D, degrees. NaN when a limb has no length. */
function angle3(a: Joint, b: Joint, c: Joint): number {
  const ux = a.x - b.x, uy = a.y - b.y, uz = a.z - b.z
  const vx = c.x - b.x, vy = c.y - b.y, vz = c.z - b.z
  const n = Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz)
  if (!(n > 1e-12)) return NaN
  const cos = (ux * vx + uy * vy + uz * vz) / n
  return Math.acos(Math.min(1, Math.max(-1, cos))) * DEG
}

/**
 * Least-squares slope of the samples within VEL_WINDOW_MS of t, units per second. When those span less than
 * VEL_MIN_SPAN_MS (a skipped frame or a low frame rate), older samples within HISTORY_GAP_MS are added.
 */
function regress(hist: readonly Rel[], t: number): Vec2 | null {
  let n = 0, su = 0, suu = 0, sx = 0, sy = 0, sux = 0, suy = 0
  let oldest = t
  for (let i = hist.length - 1; i >= 0; i--) {
    const s = hist[i]
    if (t - s.t > VEL_WINDOW_MS + VEL_SLACK_MS && (t - oldest >= VEL_MIN_SPAN_MS || t - s.t > HISTORY_GAP_MS)) break
    const u = (s.t - t) / 1000
    n++
    su += u
    suu += u * u
    sx += s.x
    sy += s.y
    sux += u * s.x
    suy += u * s.y
    oldest = s.t
  }
  if (n < 2 || t - oldest < VEL_MIN_SPAN_MS) return null
  const den = n * suu - su * su
  if (!(den > 0)) return null
  return { x: (n * sux - su * sx) / den, y: (n * suy - su * sy) / den }
}

export function createArcheryDetector(): ArcheryDetector {
  const wrists: [WristState, WristState] = [newWrist('left'), newWrist('right')]
  const wristOf = (h: Hand): WristState => (h === 'left' ? wrists[0] : wrists[1])

  let phase: DrawPhase = 'idle'
  /** Locked while drawing or armed. */
  let bowHand: Hand | null = null
  /** Bow hand of the last armed draw. Survives reset(). */
  let preference: Hand | null = null
  /** Debounced guess while idle, from angles or geometry. */
  let idleHand: Hand | null = null
  let idleVote: Hand | null = null
  let idleVotes = 0
  let flipVotes = 0
  let handFrom = ''
  /** Hands came together (or arms went down) since the last release, reset or tracking loss. */
  let recovered = false
  /** Tension that starts a draw. Raised after a let-down so a hover near LETDOWN_TENSION cannot flap. */
  let startTension = DRAW_START_TENSION

  let lastT: number | null = null
  let lastGoodT: number | null = null
  /** Last frame time, estimated across null frames. */
  let clock = 0
  let dtEst = DEFAULT_DT_MS
  let lostMs = 0

  let swWorld = 0.36
  let tension = 0
  let tensionRaw = 0
  let gateOk = false
  /** |x_left - x_right| this frame, live SW. */
  let gap = 0
  /** Smallest gap since the draw started (gate open), live SW. */
  let minGap = Infinity
  let aboveSince: number | null = null
  let relaxedSince: number | null = null
  let armedT = 0
  let aimRef: Vec2 = { x: 0, y: 0 }
  let aim: Vec2 = { x: 0, y: 0 }
  let swayMm: number | null = null

  /** Current hold of the draw hand (slow at tension > ARM_TENSION), and the last finished one. */
  let restStart: number | null = null
  let restEnd = 0
  /** Draw wrist rel position on the newest hold frame. */
  let restDraw: Vec2 = { x: 0, y: 0 }
  /** Consecutive non-holding frames inside the current hold (one is tolerated as noise). */
  let restBreaks = 0
  let lastRest: { start: number; end: number } | null = null
  /** Peak draw-hand speed since the last hold ended. */
  let motionPeak = 0
  /** First frame of a release trigger, waiting for confirmation, with the summed wrist speeds of its frames. */
  let pending: { t: number; trigger: ReleaseTrigger; n: number; drawSum: number; bowSum: number } | null = null

  let ring: Snapshot[] = []
  let sway: SwaySample[] = []
  let last: DrawSample | null = null

  let lastTrigger = ''
  let releases = 0
  let letdowns = 0
  let teleports = 0

  function clearMotion(): void {
    restStart = null
    restBreaks = 0
    lastRest = null
    motionPeak = 0
    pending = null
  }

  function toIdle(): void {
    phase = 'idle'
    bowHand = null
    aboveSince = null
    relaxedSince = null
    flipVotes = 0
    aim = { x: 0, y: 0 }
    swayMm = null
    recovered = false
    clearMotion()
  }

  function trackWrist(w: WristState, f: BodyFrame, mid: Vec2, scale: number, pxPerSw: number): void {
    const j = f.body[w.wrist]
    const t = f.t
    const rel: Rel = { t, x: (j.x - mid.x) / scale, y: (j.y - mid.y) / scale }
    w.teleported = false
    const prev = w.hist[w.hist.length - 1]
    if (prev !== undefined) {
      // t strictly increases (checked in push), so dt > 0.
      const dt = t - prev.t
      if (dt > HISTORY_GAP_MS) {
        w.hist = []
      } else if ((Math.hypot(rel.x - prev.x, rel.y - prev.y) * 1000) / dt > TELEPORT_SPEED) {
        w.hist = []
        w.teleported = true
        teleports++
      }
    }
    w.hist.push(rel)
    while (w.hist.length > 2 && t - w.hist[0].t > HISTORY_KEEP_MS) w.hist.shift()
    w.rel = { x: rel.x, y: rel.y }
    w.vel = regress(w.hist, t)

    // Both regimes run every frame, so switching between them never jumps.
    if (w.filterT === null || t - w.filterT > FILTER_RESET_GAP_MS) {
      for (const fl of w.relaxed) fl.reset()
      for (const fl of w.tight) fl.reset()
    }
    w.filterT = t
    const px = j.x * pxPerSw
    const py = j.y * pxPerSw
    w.relaxedPos = { x: w.relaxed[0].filter(px, t) / pxPerSw, y: w.relaxed[1].filter(py, t) / pxPerSw }
    w.tightPos = { x: w.tight[0].filter(px, t) / pxPerSw, y: w.tight[1].filter(py, t) / pxPerSw }
    w.resid2 = ((j.x - w.tightPos.x) ** 2 + (j.y - w.tightPos.y) ** 2) / (scale * scale)

    const s = f.world[w.shoulder]
    const e = f.world[w.elbow]
    const x = f.world[w.wrist]
    w.angle = finite(s) && finite(e) && finite(x) && e.visibility >= ELBOW_MIN_VISIBILITY ? angle3(s, e, x) : NaN
  }

  /** Bow hand evidence this frame: straight vs bent elbow first, then the wrist further out. null = no evidence. */
  function judgeHand(): Verdict | null {
    const [l, r] = wrists
    if (Number.isFinite(l.angle) && Number.isFinite(r.angle)) {
      if (l.angle > BOW_MIN_DEG && r.angle < DRAW_MAX_DEG) return { hand: 'left', how: 'angle' }
      if (r.angle > BOW_MIN_DEG && l.angle < DRAW_MAX_DEG) return { hand: 'right', how: 'angle' }
    }
    const dl = Math.abs(l.rel.x)
    const dr = Math.abs(r.rel.x)
    if (Math.abs(dl - dr) > GEOMETRY_MARGIN_SW) return { hand: dl > dr ? 'left' : 'right', how: 'geometry' }
    return null
  }

  function voteIdle(v: Verdict | null): void {
    if (v === null) {
      idleVotes = 0
      return
    }
    if (v.hand === idleVote) idleVotes++
    else {
      idleVote = v.hand
      idleVotes = 1
    }
    if (idleVotes >= HAND_VOTES) idleHand = v.hand
  }

  function startDraw(v: Verdict | null): void {
    phase = 'drawing'
    bowHand = v?.hand ?? idleHand ?? preference ?? DEFAULT_BOW_HAND
    handFrom = v?.how ?? (idleHand ? 'idle' : preference ? 'preference' : 'default')
    aboveSince = null
    relaxedSince = null
    flipVotes = 0
    minGap = gap
    clearMotion()
  }

  /** The lock may still be corrected while drawing (an early lock can be a guess). Never once armed. */
  function voteFlip(v: Verdict | null): void {
    if (v === null || v.hand === bowHand) {
      flipVotes = 0
      return
    }
    if (++flipVotes < HAND_VOTES) return
    bowHand = v.hand
    handFrom = v.how
    flipVotes = 0
    clearMotion()
  }

  function updateArming(t: number): void {
    if (bowHand === null) return
    if (!(tension > ARM_TENSION)) {
      aboveSince = null
      return
    }
    if (aboveSince === null) aboveSince = t
    if (t - aboveSince < ARM_HOLD_MS) return
    phase = 'armed'
    armedT = t
    preference = bowHand
    const p = wristOf(bowHand).tightPos
    aimRef = { x: p.x, y: p.y }
  }

  function classify(v: Vec2, bow: WristState, draw: WristState): ReleaseTrigger | null {
    if (tensionRaw < LETDOWN_TENSION) return null
    const speed = Math.hypot(v.x, v.y)
    const awaySign = Math.sign(draw.rel.x - bow.rel.x) || (bow.hand === 'left' ? 1 : -1)
    const away = v.x * awaySign
    // Toward the bow hand is a let-down, never a release.
    if (-away > DIR_COS * speed) return null
    const bowFall = bow.vel?.y ?? 0
    const drop = v.y > DROP_SPEED && v.y >= DIR_COS * speed && bowFall <= BOW_FALL_RATIO * v.y
    const snap = speed > SNAP_SPEED && away >= DIR_COS * speed
    if (drop && (!snap || v.y >= away)) return 'drop'
    return snap ? 'snap' : null
  }

  /** The bow wrist stayed put over the trigger frames, so this is not both arms lowering or swinging. */
  function bowStill(p: { n: number; drawSum: number; bowSum: number }): boolean {
    if (p.n === 0) return true
    return p.bowSum / p.n <= Math.max(BOW_STILL_MIN_SPEED, (BOW_STILL_RATIO * p.drawSum) / p.n)
  }

  /** Low frame rates: the draw hand is still well past its held position in the trigger direction. */
  function stillPast(trigger: ReleaseTrigger, bow: WristState, draw: WristState): boolean {
    const dx = draw.rel.x - restDraw.x
    const dy = draw.rel.y - restDraw.y
    if (trigger === 'drop') return dy >= LOW_FPS_CONFIRM_SW
    const awaySign = Math.sign(draw.rel.x - bow.rel.x) || (bow.hand === 'left' ? 1 : -1)
    return dx * awaySign >= LOW_FPS_CONFIRM_SW
  }

  /** The draw hand is pulled back from its closest approach to the bow hand (see PULLBACK_SW). */
  function pulledBack(): boolean {
    return gap >= minGap + PULLBACK_SW || gap >= FULL_DRAW_GAP_SW
  }

  /** Newest snapshot at or before t (the oldest one if all are newer). */
  function snapshotAt(t: number): Snapshot | null {
    for (let i = ring.length - 1; i >= 0; i--) if (ring[i].t <= t) return ring[i]
    return ring[0] ?? null
  }

  /** RMS bow-wrist residual over [from, to], live SW. Falls back to the newest sample before `to`. */
  function rmsSway(hand: Hand, from: number, to: number): number {
    let sum = 0
    let n = 0
    let fallback: number | null = null
    for (const s of sway) {
      if (s.t > to) break
      const v = hand === 'left' ? s.l : s.r
      fallback = v
      if (s.t >= from) {
        sum += v
        n++
      }
    }
    if (n > 0) return Math.sqrt(sum / n)
    return fallback === null ? 0 : Math.sqrt(fallback)
  }

  /** The hold the current motion started from: still open, or the last finished one. */
  function currentRest(): { start: number; end: number } | null {
    return restStart !== null ? { start: restStart, end: restEnd } : lastRest
  }

  function fire(t: number): ReleaseInfo | null {
    const p = pending
    pending = null
    if (p === null || bowHand === null || !bowStill(p)) return null
    const hand = bowHand
    // Sample before the motion so the snap itself does not spoil tension, aim or sway.
    const rest = currentRest()
    const refT = rest?.end ?? t
    const pre = snapshotAt(refT - PRE_RELEASE_MS)
    const holdFrom = Math.min(armedT, rest?.start ?? armedT)
    const rms = num(rmsSway(hand, Math.max(refT - SWAY_WINDOW_MS, holdFrom), refT))
    const mm = rms * swWorld * 1000
    const info: ReleaseInfo = {
      t,
      tension: pre?.tension ?? tension,
      aim: pre ? { x: pre.ax, y: pre.ay } : { x: aim.x, y: aim.y },
      bowHand: hand,
      trigger: p.trigger,
      peakVelocity: num(motionPeak),
      rmsSway: rms,
      rmsSwayMm: mm,
      stability: stabilityScore(mm),
      holdMs: Math.max(0, t - armedT),
      bowElbowDeg: wristOf(hand).angle,
      drawElbowDeg: wristOf(otherHand(hand)).angle,
    }
    lastTrigger = p.trigger
    releases++
    toIdle()
    return info
  }

  /** Hold tracking and the release trigger for the locked draw hand. */
  function updateRelease(t: number): ReleaseInfo | null {
    if (bowHand === null) return null
    const bow = wristOf(bowHand)
    const draw = wristOf(otherHand(bowHand))
    const v = draw.vel
    // The hand flew out of view or glitched mid-release: the motion was already seen, fire now.
    if (pending !== null && (v === null || draw.teleported)) return fire(t)
    // No velocity yet (history just restarted): keep the hold. RELEASE_WINDOW_MS still lets a stale one expire.
    if (v === null) return null
    // Below about 20 fps a quick snap spans one fast frame: the next one confirms it if the hand stayed out.
    if (pending !== null && dtEst > LOW_FPS_DT_MS && stillPast(pending.trigger, bow, draw)) return fire(t)
    const speed = Math.hypot(v.x, v.y)
    if (speed < SETTLE_SPEED && tension > ARM_TENSION && pulledBack()) {
      if (restStart === null) restStart = t
      restEnd = t
      restBreaks = 0
      motionPeak = 0
      pending = null
      restDraw = { x: draw.rel.x, y: draw.rel.y }
      return null
    }
    // One fast frame inside a hold is landmark noise; the hold ends on the second in a row.
    if (restStart !== null && ++restBreaks >= 2) {
      lastRest = { start: restStart, end: restEnd }
      restStart = null
    }
    motionPeak = Math.max(motionPeak, speed)
    const rest = currentRest()
    if (phase !== 'armed' || rest === null) {
      pending = null
      return null
    }
    const settled = rest.end - rest.start >= SETTLE_MS && t - rest.end <= RELEASE_WINDOW_MS
    const trigger = settled ? classify(v, bow, draw) : null
    if (trigger === null) {
      pending = null
      return null
    }
    if (pending === null) pending = { t, trigger, n: 0, drawSum: 0, bowSum: 0 }
    else pending.trigger = trigger
    // Unknown bow velocity (its history just restarted) adds nothing, so it counts as still.
    if (bow.vel !== null) {
      pending.n++
      pending.drawSum += speed
      pending.bowSum += Math.hypot(bow.vel.x, bow.vel.y)
    }
    return t - pending.t >= CONFIRM_MS ? fire(t) : null
  }

  function emit(t: number, tracked: boolean, release: ReleaseInfo | null): DrawSample {
    const s: DrawSample = {
      t,
      tracked,
      phase,
      tension,
      bowHand: phase === 'idle' ? (idleHand ?? preference) : bowHand,
      aim: phase === 'armed' ? { x: aim.x, y: aim.y } : { x: 0, y: 0 },
      swayMm: phase === 'armed' ? swayMm : null,
      release,
    }
    last = s
    return s
  }

  /** Null or untracked frame. t is null for null frames (time is estimated from the frame rate). */
  function lose(t: number | null): DrawSample {
    const now = t ?? clock + dtEst
    clock = now
    // The wrist history is kept: trackWrist restarts it after a gap over HISTORY_GAP_MS, and a shorter one
    // then reads like a skipped frame.
    for (const w of wrists) {
      w.vel = null
      w.teleported = false
    }
    aboveSince = null
    const release = pending !== null ? fire(now) : null
    lostMs = lastGoodT === null ? Infinity : now - lastGoodT
    if (lostMs > HOLD_GRACE_MS) clearMotion()
    if (lostMs > LOST_MS) {
      if (phase !== 'idle') toIdle()
      recovered = false
      tension = 0
    }
    return emit(now, false, release)
  }

  function push(f: BodyFrame | null): DrawSample {
    if (f === null || !Array.isArray(f.body) || f.body.length < 33 || !Array.isArray(f.world) || f.world.length < 33 || !Number.isFinite(f.t)) {
      return lose(null)
    }
    const t = f.t
    // Same or older frame: nothing new (and a release can never repeat).
    if (lastT !== null && !(t > lastT)) return last ? { ...last, aim: { ...last.aim }, release: null } : emit(t, false, null)
    if (lastT !== null) dtEst += (Math.min(100, Math.max(5, t - lastT)) - dtEst) * 0.2
    lastT = t
    clock = t
    const b = f.body
    if (![LM.L_SHOULDER, LM.R_SHOULDER, LM.L_WRIST, LM.R_WRIST].every((i) => usable(b[i]))) return lose(t)

    const ls = b[LM.L_SHOULDER]
    const rs = b[LM.R_SHOULDER]
    const mid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 }
    const scale = Number.isFinite(f.scale) && f.scale > MIN_SCALE ? f.scale : 1
    const cal = f.calibration
    const pxPerSw = Math.max(num(cal?.shoulderWidth ?? 0), 0.01) * FILTER_HEIGHT_PX
    swWorld = Math.max(num(cal?.shoulderWidthWorld ?? 0), 0.1)
    for (const w of wrists) trackWrist(w, f, mid, scale, pxPerSw)
    lastGoodT = t
    lostMs = 0

    const [l, r] = wrists
    gap = Math.abs(l.rel.x - r.rel.x)
    tensionRaw = clamp01((gap - TENSION_MIN_SW) / (TENSION_MAX_SW - TENSION_MIN_SW))
    gateOk = l.rel.y < DRAW_MAX_DROP_SW && r.rel.y < DRAW_MAX_DROP_SW
    if (bowHand !== null && wristOf(otherHand(bowHand)).rel.y < -DRAW_MAX_RISE_SW) gateOk = false
    tension = gateOk ? tensionRaw : 0
    if (tensionRaw < DRAW_START_TENSION || !gateOk) startTension = DRAW_START_TENSION
    sway.push({ t, l: l.resid2, r: r.resid2 })
    while (sway.length > 1 && t - sway[0].t > RING_MS) sway.shift()
    const verdict = judgeHand()

    if (phase === 'idle') {
      if (gateOk) voteIdle(verdict)
      if (!recovered && (tensionRaw < RECOVER_TENSION || !gateOk)) recovered = true
      if (recovered && gateOk && tension > startTension) startDraw(verdict)
    }
    if (phase === 'drawing') {
      voteFlip(verdict)
      updateArming(t)
    }
    if (phase !== 'idle') {
      if (tension < LETDOWN_TENSION) {
        if (relaxedSince === null) relaxedSince = t
        if (t - relaxedSince >= LETDOWN_MS) {
          letdowns++
          toIdle()
          startTension = RECOVER_TENSION
        }
      } else {
        relaxedSince = null
      }
    }
    if (phase !== 'idle' && gateOk) minGap = Math.min(minGap, gap)
    const release = phase !== 'idle' ? updateRelease(t) : null

    if (phase === 'armed' && bowHand !== null) {
      const p = wristOf(bowHand).tightPos
      aim = { x: (p.x - aimRef.x) / scale, y: -(p.y - aimRef.y) / scale }
      swayMm = num(rmsSway(bowHand, Math.max(t - SWAY_WINDOW_MS, armedT), t)) * swWorld * 1000
    } else {
      aim = { x: 0, y: 0 }
      swayMm = null
    }
    ring.push({ t, tension, ax: aim.x, ay: aim.y })
    while (ring.length > 1 && t - ring[0].t > RING_MS) ring.shift()
    return emit(t, true, release)
  }

  return {
    push,

    reset() {
      toIdle()
      idleHand = null
      idleVote = null
      idleVotes = 0
      startTension = DRAW_START_TENSION
      tension = 0
      ring = []
      sway = []
    },

    get debug(): Record<string, number | string> {
      const bow = bowHand ? wristOf(bowHand) : null
      const draw = bowHand ? wristOf(otherHand(bowHand)) : null
      // Filtered bow wrist as shown: relaxed regime while idle, tight once drawn.
      const shownHand = bowHand ?? idleHand ?? preference
      const shown = shownHand ? (phase === 'idle' ? wristOf(shownHand).relaxedPos : wristOf(shownHand).tightPos) : null
      const v = draw?.vel ?? null
      const rest = currentRest()
      const restMs = rest ? rest.end - rest.start : 0
      const d: Record<string, number | string> = {
        phase,
        tension,
        tensionRaw,
        bowHand: bowHand ?? '',
        handFrom,
        preference: preference ?? '',
        elbowL: num(wrists[0].angle),
        elbowR: num(wrists[1].angle),
        drawSpeed: v ? num(Math.hypot(v.x, v.y)) : 0,
        drawVx: v ? num(v.x) : 0,
        drawVy: v ? num(v.y) : 0,
        bowVy: num(bow?.vel?.y ?? 0),
        bowFx: num(shown?.x ?? 0),
        bowFy: num(shown?.y ?? 0),
        restMs,
        pending: pending ? 1 : 0,
        swayMm: num(swayMm ?? 0),
        armedMs: phase === 'armed' && lastT !== null ? lastT - armedT : 0,
        lostMs: num(lostMs),
        gate: gateOk ? 1 : 0,
        gap: num(gap),
        minGap: num(minGap),
        needsRecover: recovered ? 0 : 1,
        lastTrigger,
        releases,
        letdowns,
        teleports,
      }
      return d
    },
  }
}
