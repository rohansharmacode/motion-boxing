// Runs pose frames through the real detectors and scores them per motion label. Shared by the replay CLI
// (tools/replay-detectors.ts), the record/train page (src/dev/recordPage.ts) and tests/unit/replay-score.test.ts.
// Pure: no fs, no DOM.
import { createBodyTracker } from '../../src/pose/body.ts'
import { createCalibrator } from '../../src/pose/calibration.ts'
import type { Calibration, PoseFrame } from '../../src/pose/types.ts'
import { ARCHERY_TRACKER_FILTER, createArcheryDetector } from '../../src/sports/archery/detector.ts'
import { BOXING_FILTER, DEFAULT_BOXING_CONFIG, createBoxingDetector, type BoxingDetectorConfig } from '../../src/sports/boxing/detector.ts'
import { unpackPose, type MotionLabel, type Recording } from '../../src/dev/recordingFormat.ts'

/** A detector output, named with the recorder's label for the motion it stands for. */
export interface DetectedEvent {
  t: number
  type: MotionLabel
  /** e.g. the punch kind for a straight ("jab" or "cross"), useful for misclassification reports. */
  detail: string
}

/** Labels that have a detector today. The others are reported as "no detector". */
export const SCORED_LABELS: MotionLabel[] = [
  'jab-L', 'jab-R', 'hook', 'uppercut', 'block', 'dodge-L', 'dodge-R', 'duck', 'archery-draw', 'archery-release',
]

export interface ReplayOptions {
  boxing?: Partial<BoxingDetectorConfig>
}

export interface EventExtractor {
  /** Feed every frame in time order. Returns the events this frame produced. */
  push(frame: PoseFrame | null): DetectedEvent[]
  readonly calibration: Calibration | null
  /** Calibrator status while not calibrated ('done' after). */
  readonly status: string
  readonly calibratedAt: number | null
}

/**
 * The game's chain, frame by frame: the calibrator on the first frames (guard hold), then a body tracker + detector
 * per sport, each with that sport's tracker filter. Boxing and archery run side by side on every frame.
 */
export function createEventExtractor(aspect: number, opts: ReplayOptions = {}): EventExtractor {
  const calibrator = createCalibrator()
  let calibration: Calibration | null = null
  let calibratedAt: number | null = null
  let status = 'no-pose'
  let boxTracker: ReturnType<typeof createBodyTracker> | null = null
  let arcTracker: ReturnType<typeof createBodyTracker> | null = null
  const boxing = createBoxingDetector(opts.boxing ?? {})
  const archery = createArcheryDetector()
  let guard = false
  let slip: string | null = null
  let archeryPhase = 'idle'
  let lastT = 0

  return {
    get calibration() { return calibration },
    get status() { return status },
    get calibratedAt() { return calibratedAt },
    push(frame) {
      if (frame) lastT = frame.t
      if (!calibration) {
        const p = calibrator.push(frame, aspect)
        status = p.status
        if (p.status === 'done' && p.calibration) {
          calibration = p.calibration
          calibratedAt = lastT
          boxTracker = createBodyTracker(calibration, BOXING_FILTER)
          arcTracker = createBodyTracker(calibration, ARCHERY_TRACKER_FILTER)
        }
        return []
      }
      const out: DetectedEvent[] = []
      const b = boxing.update(boxTracker!.push(frame))
      for (const p of b.punches) {
        const type: MotionLabel = p.kind === 'hook' ? 'hook' : p.kind === 'uppercut' ? 'uppercut' : p.hand === 'left' ? 'jab-L' : 'jab-R'
        out.push({ t: p.t, type, detail: `${p.kind}/${p.hand}` })
      }
      if (b.guard && !guard) out.push({ t: lastT, type: 'block', detail: 'guard' })
      if (b.slip && b.slip !== slip) {
        out.push({ t: lastT, type: b.slip === 'duck' ? 'duck' : b.slip === 'left' ? 'dodge-L' : 'dodge-R', detail: `slip ${b.slip}` })
      }
      guard = b.guard
      slip = b.slip

      const a = archery.push(arcTracker!.push(frame))
      if (a.phase !== 'idle' && archeryPhase === 'idle') out.push({ t: a.t, type: 'archery-draw', detail: `bow ${a.bowHand ?? '?'}` })
      archeryPhase = a.phase
      if (a.release) {
        out.push({ t: a.release.t, type: 'archery-release', detail: 'release' })
        archery.reset() // the game resets the detector for every new arrow
        archeryPhase = 'idle'
      }
      return out
    },
  }
}

export interface TakeEvents {
  calibration: Calibration | null
  /** t of the frame where calibration finished (null if never). */
  calibratedAt: number | null
  events: DetectedEvent[]
  /** Frames with a pose / all frames. */
  poseFrames: number
  frames: number
  /** Mean frames per second over frames with a pose. */
  fps: number
}

/** Replays one whole recording. */
export function replayTake(rec: Recording, opts: ReplayOptions = {}): TakeEvents {
  const x = createEventExtractor(rec.aspect, opts)
  const events: DetectedEvent[] = []
  let poseFrames = 0
  let firstT: number | null = null
  let lastT = 0
  for (const packed of rec.frames) {
    const frame = unpackPose(packed)
    if (frame) {
      poseFrames++
      firstT ??= frame.t
      lastT = frame.t
    }
    events.push(...x.push(frame))
  }
  const secs = firstT !== null ? (lastT - firstT) / 1000 : 0
  return { calibration: x.calibration, calibratedAt: x.calibratedAt, events, poseFrames, frames: rec.frames.length, fps: secs > 0 ? poseFrames / secs : 0 }
}

/** Rep marks match a same-type event within this window (event after the mark is normal: the operator is late or early). */
export const MATCH_WINDOW_MS = 800

export interface MotionScore {
  label: MotionLabel
  reps: number
  tp: number
  fn: number
  /** Events of this type that are not a matched rep: extra ones in its own segments, or any in other segments / idle. */
  fp: number
  /** Detection latency vs the operator's mark, ms (only marked reps). */
  latencies: number[]
  /** For straights: how the detector named them (jab vs cross), counts. */
  kinds: Record<string, number>
}

export interface Scores {
  byLabel: Map<MotionLabel, MotionScore>
  /** segment label -> detected type -> count (every event inside a segment window). */
  confusion: Map<MotionLabel, Map<MotionLabel, number>>
  /** Events outside every segment (between sets): not scored, reported. */
  unlabelled: number
  /** Minutes of idle segments (for a per-minute false-trigger rate). */
  idleMinutes: number
}

export function emptyScores(): Scores {
  return { byLabel: new Map(), confusion: new Map(), unlabelled: 0, idleMinutes: 0 }
}

function scoreOf(s: Scores, label: MotionLabel): MotionScore {
  let m = s.byLabel.get(label)
  if (!m) s.byLabel.set(label, (m = { label, reps: 0, tp: 0, fn: 0, fp: 0, latencies: [], kinds: {} }))
  return m
}

/**
 * Adds one take's events to the running scores. Only events of `types` count (default: every type), so a boxing
 * take is not charged with archery triggers and vice versa.
 */
export function scoreTake(rec: Recording, take: TakeEvents, into: Scores = emptyScores(), types?: readonly MotionLabel[]): Scores {
  const events = types ? take.events.filter((e) => types.includes(e.type)) : take.events
  const used = new Set<DetectedEvent>()
  for (const seg of rec.segments) {
    const inSeg = events.filter((e) => e.t >= seg.startT && e.t <= seg.endT + 300)
    const row = into.confusion.get(seg.label) ?? new Map<MotionLabel, number>()
    into.confusion.set(seg.label, row)
    for (const e of inSeg) row.set(e.type, (row.get(e.type) ?? 0) + 1)
    if (seg.label === 'idle') into.idleMinutes += (seg.endT - seg.startT) / 60000

    const m = scoreOf(into, seg.label)
    m.reps += seg.reps
    const same = inSeg.filter((e) => e.type === seg.label)
    for (const e of same) m.kinds[e.detail.split('/')[0]] = (m.kinds[e.detail.split('/')[0]] ?? 0) + 1

    let tp: number
    if (seg.marks.length > 0) {
      // Greedy nearest match of each mark to an unused same-type event.
      const free = [...same]
      tp = 0
      for (const mk of seg.marks) {
        let best = -1
        let bestD = Infinity
        free.forEach((e, i) => {
          const d = Math.abs(e.t - mk)
          if (d <= MATCH_WINDOW_MS && d < bestD) { best = i; bestD = d }
        })
        if (best >= 0) {
          m.latencies.push(Math.round(free[best].t - mk))
          used.add(free[best])
          free.splice(best, 1)
          tp++
        }
      }
      // Reps typed in can exceed marks (the operator missed a few): count those by number.
      const unmarkedReps = Math.max(0, seg.reps - seg.marks.length)
      const extraTp = Math.min(unmarkedReps, free.length)
      for (const e of free.slice(0, extraTp)) used.add(e)
      tp += extraTp
    } else {
      tp = Math.min(seg.reps, same.length)
      for (const e of same.slice(0, tp)) used.add(e)
    }
    tp = Math.min(tp, seg.reps)
    m.tp += tp
    m.fn += Math.max(0, seg.reps - tp)
  }

  for (const e of events) {
    if (used.has(e)) continue
    const inAny = rec.segments.some((s) => e.t >= s.startT && e.t <= s.endT + 300)
    if (!inAny) { into.unlabelled++; continue }
    scoreOf(into, e.type).fp++
  }
  return into
}

const pct = (n: number, d: number): string => (d > 0 ? `${((100 * n) / d).toFixed(0)}%` : '-')
const median = (xs: number[]): string => {
  if (!xs.length) return '-'
  const s = [...xs].sort((a, b) => a - b)
  return String(s[Math.floor(s.length / 2)])
}

/** Meets the target: >= 90% detected and false triggers < 5% of reps. */
export function onTarget(m: MotionScore): boolean {
  return m.reps === 0 || (m.tp / m.reps >= 0.9 && m.fp / m.reps < 0.05)
}

export interface ScoreRow {
  label: MotionLabel
  scored: boolean
  reps: number
  tp: number
  fp: number
  recall: string
  precision: string
  fpRate: string
  latency: string
  kinds: string
  ok: boolean
}

export function scoreRows(s: Scores): ScoreRow[] {
  return [...s.byLabel.keys()].filter((l) => l !== 'idle').sort().map((label) => {
    const m = s.byLabel.get(label)!
    return {
      label,
      scored: SCORED_LABELS.includes(label),
      reps: m.reps,
      tp: m.tp,
      fp: m.fp,
      recall: pct(m.tp, m.reps),
      precision: pct(m.tp, m.tp + m.fp),
      fpRate: pct(m.fp, m.reps),
      latency: median(m.latencies),
      kinds: Object.entries(m.kinds).map(([k, n]) => `${k} ${n}`).join(', '),
      ok: onTarget(m),
    }
  })
}

export function idleSummary(s: Scores): string {
  const idle = s.confusion.get('idle')
  const fires = idle ? [...idle.values()].reduce((a, b) => a + b, 0) : 0
  return `${fires} triggers in ${s.idleMinutes.toFixed(1)} min${s.idleMinutes > 0 ? ` (${(fires / s.idleMinutes).toFixed(1)}/min)` : ''}` +
    (idle && fires ? `: ${[...idle].map(([k, n]) => `${k} ${n}`).join(', ')}` : '')
}

/** Markdown table: one row per motion. Targets: recall >= 90%, false triggers < 5% of reps. */
export function formatScores(s: Scores): string {
  const lines = [
    '| Motion | Reps | Detected (recall) | Precision | False triggers | FP % of reps | Median latency vs mark (ms) | Named as |',
    '|---|---|---|---|---|---|---|---|',
  ]
  for (const r of scoreRows(s)) {
    if (!r.scored) { lines.push(`| ${r.label} | ${r.reps} | no detector yet | | | | | |`); continue }
    lines.push(`| ${r.label}${r.ok ? '' : ' ⚠'} | ${r.reps} | ${r.tp} (${r.recall}) | ${r.precision} | ${r.fp} | ${r.fpRate} | ${r.latency} | ${r.kinds} |`)
  }
  lines.push('')
  lines.push(`Idle: ${idleSummary(s)}`)
  lines.push(`Events between labelled sets (not scored): ${s.unlabelled}`)
  return lines.join('\n')
}

/** Per segment label, what fired inside it. Shows misclassifications (e.g. hooks detected during jab-R sets). */
export function formatConfusion(s: Scores): string {
  const lines = ['| During | Detected |', '|---|---|']
  for (const [label, row] of [...s.confusion].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`| ${label} | ${[...row].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing'} |`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------------------------
// Training: score many recordings under a boxing config, and search for a better one.
// ---------------------------------------------------------------------------------------------------------------

/** One number to maximise: mean F1 over the scored labels present, minus a penalty per idle trigger per minute. */
export function objective(s: Scores, labels: readonly MotionLabel[]): number {
  const f1s: number[] = []
  for (const label of labels) {
    const m = s.byLabel.get(label)
    if (!m || m.reps === 0 || !SCORED_LABELS.includes(label)) continue
    const p = m.tp + m.fp > 0 ? m.tp / (m.tp + m.fp) : 0
    const r = m.tp / m.reps
    f1s.push(p + r > 0 ? (2 * p * r) / (p + r) : 0)
  }
  const idle = s.confusion.get('idle')
  const idleFires = idle ? [...idle].filter(([k]) => labels.includes(k)).reduce((a, [, n]) => a + n, 0) : 0
  const idlePerMin = s.idleMinutes > 0 ? idleFires / s.idleMinutes : 0
  const meanF1 = f1s.length ? f1s.reduce((a, b) => a + b, 0) / f1s.length : 0
  return meanF1 - 0.05 * idlePerMin
}

export function scoreAll(recs: Recording[], opts: ReplayOptions, types: readonly MotionLabel[]): Scores {
  const s = emptyScores()
  for (const rec of recs) scoreTake(rec, replayTake(rec, opts), s, types)
  return s
}

/** Boxing thresholds the auto-tuner may move, with a step size each (absolute units of that field). */
export const BOXING_TUNABLES: Array<{ key: keyof BoxingDetectorConfig; step: number; min: number; max: number; what: string }> = [
  { key: 'straightMinDtheta', step: 20, min: 60, max: 400, what: 'straight: elbow extension speed (deg/s)' },
  { key: 'straightMinTheta', step: 5, min: 100, max: 170, what: 'straight: elbow angle (deg)' },
  { key: 'straightMinForward', step: 0.02, min: 0, max: 0.2, what: 'straight: forward reach past guard (m)' },
  { key: 'thrustMinFwd', step: 0.3, min: 0.5, max: 5, what: 'thrust straight: forward wrist speed (SW/s)' },
  { key: 'crossMinYaw', step: 3, min: 0, max: 40, what: 'cross vs jab: shoulder yaw (deg)' },
  { key: 'hookMinSpeed', step: 0.3, min: 0.8, max: 6, what: 'hook: lateral speed (SW/s)' },
  { key: 'hookMinLateralRatio', step: 0.15, min: 0.8, max: 3, what: 'hook: lateral dominance' },
  { key: 'uppercutMinSpeed', step: 0.3, min: 0.8, max: 6, what: 'uppercut: upward speed (SW/s)' },
  { key: 'cooldownMs', step: 30, min: 60, max: 500, what: 'same-hand cooldown (ms)' },
  { key: 'retractFraction', step: 0.05, min: 0.1, max: 0.9, what: 'hysteresis: pull-back before re-arm' },
  { key: 'velocityMinVisibility', step: 0.05, min: 0.2, max: 0.9, what: 'visibility gate for velocity' },
  { key: 'guardMaxNoseDist', step: 0.05, min: 0.3, max: 1, what: 'block: wrists to nose (SW)' },
  { key: 'slipMinNoseX', step: 0.03, min: 0.1, max: 0.6, what: 'slip: sideways head move (SW)' },
  { key: 'duckMinDrop', step: 0.03, min: 0.08, max: 0.5, what: 'duck: head drop (SW)' },
]

export interface TuneStep {
  round: number
  key: string
  value: number
  objective: number
  accepted: boolean
}

/**
 * Coordinate search: for each tunable, try one step down and one step up; keep a change only if the objective
 * improves. Repeats for `rounds`. `onStep` can yield to the UI (await it) and report progress.
 */
export async function autoTuneBoxing(
  recs: Recording[],
  types: readonly MotionLabel[],
  start: Partial<BoxingDetectorConfig> = {},
  rounds = 2,
  onStep?: (s: TuneStep) => void | Promise<void>,
): Promise<{ config: Partial<BoxingDetectorConfig>; before: number; after: number }> {
  const cfg: Partial<BoxingDetectorConfig> = { ...start }
  const value = (k: keyof BoxingDetectorConfig): number => (cfg[k] ?? DEFAULT_BOXING_CONFIG[k]) as number
  const before = objective(scoreAll(recs, { boxing: cfg }, types), types)
  let best = before
  for (let round = 1; round <= rounds; round++) {
    let improved = false
    for (const t of BOXING_TUNABLES) {
      for (const dir of [-1, 1]) {
        const v = Math.round((value(t.key) + dir * t.step) * 1000) / 1000
        if (v < t.min || v > t.max) continue
        const trial = { ...cfg, [t.key]: v }
        const o = objective(scoreAll(recs, { boxing: trial }, types), types)
        const accepted = o > best + 1e-6
        if (accepted) { best = o; Object.assign(cfg, { [t.key]: v }); improved = true }
        await onStep?.({ round, key: t.key, value: v, objective: o, accepted })
      }
    }
    if (!improved) break
  }
  return { config: cfg, before, after: best }
}
