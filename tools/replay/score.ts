// Replays motion recordings through the real detectors and scores them per motion label.
// Pure (no fs): tools/replay-detectors.ts does the file I/O, tests/unit/replay-score.test.ts tests this.
import { createBodyTracker } from '../../src/pose/body.ts'
import { createCalibrator } from '../../src/pose/calibration.ts'
import type { Calibration } from '../../src/pose/types.ts'
import { ARCHERY_TRACKER_FILTER, createArcheryDetector } from '../../src/sports/archery/detector.ts'
import { BOXING_FILTER, createBoxingDetector, type BoxingDetectorConfig } from '../../src/sports/boxing/detector.ts'
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

/**
 * Runs one recording through the game's chain: the calibrator on the first frames (the take starts with a guard
 * hold), then a body tracker + detector per sport, each with that sport's tracker filter.
 */
export function replayTake(rec: Recording, opts: ReplayOptions = {}): TakeEvents {
  const calibrator = createCalibrator()
  let calibration: Calibration | null = null
  let calibratedAt: number | null = null
  let boxTracker: ReturnType<typeof createBodyTracker> | null = null
  let arcTracker: ReturnType<typeof createBodyTracker> | null = null
  const boxing = createBoxingDetector(opts.boxing ?? {})
  const archery = createArcheryDetector()
  const events: DetectedEvent[] = []
  let guard = false
  let slip: string | null = null
  let archeryPhase = 'idle'
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
    if (!calibration) {
      const p = calibrator.push(frame, rec.aspect)
      if (p.status === 'done' && p.calibration) {
        calibration = p.calibration
        calibratedAt = frame?.t ?? lastT
        boxTracker = createBodyTracker(calibration, BOXING_FILTER)
        arcTracker = createBodyTracker(calibration, ARCHERY_TRACKER_FILTER)
      }
      continue
    }

    const b = boxing.update(boxTracker!.push(frame))
    for (const p of b.punches) {
      const type: MotionLabel = p.kind === 'hook' ? 'hook' : p.kind === 'uppercut' ? 'uppercut' : p.hand === 'left' ? 'jab-L' : 'jab-R'
      events.push({ t: p.t, type, detail: `${p.kind}/${p.hand}` })
    }
    const t = frame?.t ?? lastT
    if (b.guard && !guard) events.push({ t, type: 'block', detail: 'guard' })
    if (b.slip && b.slip !== slip) {
      events.push({ t, type: b.slip === 'duck' ? 'duck' : b.slip === 'left' ? 'dodge-L' : 'dodge-R', detail: `slip ${b.slip}` })
    }
    guard = b.guard
    slip = b.slip

    const a = archery.push(arcTracker!.push(frame))
    if (a.phase !== 'idle' && archeryPhase === 'idle') events.push({ t: a.t, type: 'archery-draw', detail: `bow ${a.bowHand ?? '?'}` })
    archeryPhase = a.phase
    if (a.release) {
      events.push({ t: a.release.t, type: 'archery-release', detail: 'release' })
      archery.reset() // the game resets the detector for every new arrow
      archeryPhase = 'idle'
    }
  }
  const secs = firstT !== null ? (lastT - firstT) / 1000 : 0
  return { calibration, calibratedAt, events, poseFrames, frames: rec.frames.length, fps: secs > 0 ? poseFrames / secs : 0 }
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

/** Adds one take's events to the running scores. */
export function scoreTake(rec: Recording, take: TakeEvents, into: Scores = emptyScores()): Scores {
  const used = new Set<DetectedEvent>()
  for (const seg of rec.segments) {
    const inSeg = take.events.filter((e) => e.t >= seg.startT && e.t <= seg.endT + 300)
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

  for (const e of take.events) {
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

/** Markdown table: one row per motion. Targets: recall >= 90%, false triggers < 5% of reps. */
export function formatScores(s: Scores): string {
  const lines = [
    '| Motion | Reps | Detected (recall) | Precision | False triggers | FP % of reps | Median latency vs mark (ms) | Named as |',
    '|---|---|---|---|---|---|---|---|',
  ]
  const labels = [...s.byLabel.keys()].sort()
  for (const label of labels) {
    const m = s.byLabel.get(label)!
    if (label === 'idle') continue
    if (!SCORED_LABELS.includes(label)) {
      lines.push(`| ${label} | ${m.reps} | no detector yet | | | | | |`)
      continue
    }
    const ok = m.reps === 0 || (m.tp / m.reps >= 0.9 && m.fp / m.reps < 0.05) ? '' : ' ⚠'
    const kinds = Object.entries(m.kinds).map(([k, n]) => `${k} ${n}`).join(', ')
    lines.push(`| ${label}${ok} | ${m.reps} | ${m.tp} (${pct(m.tp, m.reps)}) | ${pct(m.tp, m.tp + m.fp)} | ${m.fp} | ${pct(m.fp, m.reps)} | ${median(m.latencies)} | ${kinds} |`)
  }
  const idle = s.confusion.get('idle')
  const idleFires = idle ? [...idle.values()].reduce((a, b) => a + b, 0) : 0
  lines.push('')
  lines.push(`Idle: ${idleFires} triggers in ${s.idleMinutes.toFixed(1)} min${s.idleMinutes > 0 ? ` (${(idleFires / s.idleMinutes).toFixed(1)}/min)` : ''}` +
    (idle && idleFires ? `: ${[...idle].map(([k, n]) => `${k} ${n}`).join(', ')}` : ''))
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
