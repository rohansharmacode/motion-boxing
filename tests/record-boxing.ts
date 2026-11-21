// Boxing detector field test (dev server: /tests/record-boxing.html). See the header of record-boxing.html.
// Same chain as the game: startPosePipeline -> createCalibrator -> createBodyTracker(BOXING_FILTER) -> createBoxingDetector.
// Optional ?cfg=<url-encoded JSON> overrides detector config, so a tuned config can be tried live.
import { createBodyTracker, type BodyTracker } from '../src/pose/body.ts'
import { createCalibrator } from '../src/pose/calibration.ts'
import { startPosePipeline, type PosePipeline } from '../src/pose/pipeline.ts'
import type { Calibration, PoseFrame } from '../src/pose/types.ts'
import { BOXING_FILTER, createBoxingDetector, type BoxingDetectorConfig } from '../src/sports/boxing/detector.ts'
import type { PunchKind } from '../src/sports/boxing/types.ts'
import { FIXTURE_VERSION, packFrame, type BoxingFixture, type PackedFrame } from './unit/helpers/boxing-replay.ts'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const video = $<HTMLVideoElement>('video')
const status = $('status')
const live = $('live')
const logEl = $('log')

const cfgParam = new URLSearchParams(location.search).get('cfg')
const config: Partial<BoxingDetectorConfig> = cfgParam ? (JSON.parse(cfgParam) as Partial<BoxingDetectorConfig>) : {}

let pipeline: PosePipeline | null = null
let calibrator = createCalibrator()
let calibration: Calibration | null = null
let tracker: BodyTracker | null = null
let detector = createBoxingDetector(config)

type Tally = Record<PunchKind | 'guard' | 'slip' | 'duck', number>
const zero = (): Tally => ({ jab: 0, cross: 0, hook: 0, uppercut: 0, guard: 0, slip: 0, duck: 0 })
let trial: { intent: string; tally: Tally; started: number } | null = null
const rows: Array<{ light: string; dist: string; intent: string; thrown: number; tally: Tally; correct: number }> = []
let clip: { label: string; frames: PackedFrame[] } | null = null

let lastGuard = false
let lastSlip: string | null = null
let fps = 0
let lastT = 0
let lastLatency = 0

function log(msg: string): void {
  const line = document.createElement('div')
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`
  logEl.prepend(line)
}

function onFrame(frame: PoseFrame | null): void {
  if (frame) {
    if (lastT) fps = fps * 0.9 + (1000 / Math.max(1, frame.t - lastT)) * 0.1
    lastT = frame.t
    lastLatency = performance.now() - frame.t
  }
  if (!calibration) {
    const p = calibrator.push(frame, pipeline ? pipeline.videoWidth / pipeline.videoHeight : 4 / 3)
    status.textContent = `calibrating: ${p.status} ${(p.progress * 100).toFixed(0)}%`
    if (p.status === 'done' && p.calibration) {
      calibration = p.calibration
      tracker = createBodyTracker(calibration, BOXING_FILTER)
      detector = createBoxingDetector(config)
      status.textContent = `calibrated (${calibration.stance ?? 'orthodox'})`
      log('calibrated')
    }
    return
  }
  if (clip) clip.frames.push(packFrame(frame))
  const actions = detector.update(tracker!.push(frame))
  for (const p of actions.punches) {
    log(`${p.kind} (${p.hand}) ${p.peakVelocity.toFixed(1)} SW/s, elbow ${p.elbowAngle.toFixed(0)}°`)
    if (trial) trial.tally[p.kind]++
  }
  if (actions.guard && !lastGuard) { log('guard up'); if (trial) trial.tally.guard++ }
  if (actions.slip && actions.slip !== lastSlip) {
    log(actions.slip === 'duck' ? 'duck' : `slip ${actions.slip}`)
    if (trial) trial.tally[actions.slip === 'duck' ? 'duck' : 'slip']++
  }
  lastGuard = actions.guard
  lastSlip = actions.slip
  const dbg = Object.entries(actions.debug).map(([k, v]) => `${k.padEnd(18)} ${Number.isFinite(v) ? v.toFixed(2) : v}`).join('\n')
  live.textContent =
    `fps ${fps.toFixed(1)}   inference ${pipeline?.inferenceMs.toFixed(1) ?? '-'} ms   frame->detector ${lastLatency.toFixed(1)} ms\n` +
    `guard ${actions.guard ? 'UP' : 'down'}   slip ${actions.slip ?? '-'}   ${trial ? `TRIAL: ${trial.intent}` : ''}${clip ? '   REC' : ''}\n\n${dbg}`
}

function correctFor(intent: string, t: Tally): number {
  if (intent === 'idle') return 0
  return t[intent as keyof Tally] ?? 0
}

function renderTally(): void {
  const body = $('tally').querySelector('tbody')!
  body.replaceChildren(
    ...rows.map((r) => {
      const tr = document.createElement('tr')
      const cells = [`${r.light} / ${r.dist} m / ${r.intent}`, r.thrown, r.tally.jab, r.tally.cross, r.tally.hook, r.tally.uppercut, r.tally.guard, r.tally.slip, r.tally.duck,
        r.intent === 'idle' ? `${r.tally.jab + r.tally.cross + r.tally.hook + r.tally.uppercut} false` : `${r.correct}/${r.thrown}`]
      for (const c of cells) { const td = document.createElement('td'); td.textContent = String(c); tr.append(td) }
      return tr
    }),
  )
}

function download(name: string, text: string, type: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

$('start').onclick = async () => {
  if (pipeline) return
  status.textContent = 'starting camera...'
  try {
    pipeline = await startPosePipeline(video)
    calibrator = createCalibrator()
    calibration = null
    pipeline.subscribe(onFrame)
    status.textContent = 'calibrating: guard up, stand still'
  } catch (err) {
    status.textContent = `camera failed: ${String(err)}`
  }
}

$('trial').onclick = () => {
  const btn = $('trial')
  if (!trial) {
    if (!calibration) return log('calibrate first')
    trial = { intent: $<HTMLSelectElement>('intent').value, tally: zero(), started: performance.now() }
    btn.textContent = 'Stop'
    btn.classList.add('on')
    return
  }
  const thrown = trial.intent === 'idle' ? 0 : Number(prompt(`How many ${trial.intent}s did you actually do?`, '10') ?? 0)
  rows.push({ light: $<HTMLInputElement>('light').value, dist: $<HTMLInputElement>('dist').value, intent: trial.intent, thrown, tally: trial.tally, correct: correctFor(trial.intent, trial.tally) })
  trial = null
  btn.textContent = 'Start'
  btn.classList.remove('on')
  renderTally()
}

$('csv').onclick = () => {
  const head = 'lighting,distance_m,intent,thrown,jab,cross,hook,uppercut,guard,slip,duck,correct'
  const lines = rows.map((r) => [r.light, r.dist, r.intent, r.thrown, r.tally.jab, r.tally.cross, r.tally.hook, r.tally.uppercut, r.tally.guard, r.tally.slip, r.tally.duck, r.correct].join(','))
  download('boxing-detector-counts.csv', [head, ...lines].join('\n'), 'text/csv')
}

$('rec').onclick = () => {
  const btn = $('rec')
  if (!clip) {
    if (!calibration) return log('calibrate first')
    clip = { label: $<HTMLSelectElement>('clip').value, frames: [] }
    btn.textContent = 'Stop'
    btn.classList.add('on')
    return
  }
  const label = clip.label
  const n = label === 'idle-sway' ? 0 : Number(prompt(`How many ${label}s are in this clip?`, '3') ?? 0)
  const kind = label as PunchKind
  const fx: BoxingFixture = {
    version: FIXTURE_VERSION,
    label,
    expected: { punches: label === 'idle-sway' ? {} : { [kind]: n } },
    lighting: $<HTMLInputElement>('light').value,
    distanceM: Number($<HTMLInputElement>('dist').value),
    recordedAt: new Date().toISOString(),
    calibration: calibration!,
    frames: clip.frames,
  }
  download(`${label}.json`, JSON.stringify(fx), 'application/json')
  log(`saved ${label}.json (${clip.frames.length} frames)`)
  clip = null
  btn.textContent = 'Record'
  btn.classList.remove('on')
}
