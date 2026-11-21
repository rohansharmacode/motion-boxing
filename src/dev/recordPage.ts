// Motion lab (/record.html, dev server only): record real motions for every game, then train the detectors on them.
// Record: camera -> the same pose pipeline as the games; a take stores raw frames + labelled sets of reps; live
//   detections come from the same extractor the replay uses, recalibrated at each take start like the replay.
// Train: loads recordings/ for the selected game, scores them with the real detectors, lets you edit boxing
//   thresholds and re-score, or auto-tune them. Results are copied out as JSON overrides for a tuning PR.
import { createPoseOverlay } from '../pose/overlay.ts'
import { startPosePipeline, type PosePipeline } from '../pose/pipeline.ts'
import type { PoseFrame } from '../pose/types.ts'
import { DEFAULT_BOXING_CONFIG, type BoxingDetectorConfig } from '../sports/boxing/detector.ts'
import {
  GAMES, RECORDING_VERSION, gameOf, packPose, parseRecording, recordingFileName,
  type GameId, type MotionLabel, type PackedPose, type Recording, type RecordingSegment,
} from './recordingFormat.ts'
import {
  BOXING_TUNABLES, autoTuneBoxing, createEventExtractor, emptyScores, idleSummary, objective, replayTake, scoreAll, scoreRows,
  scoreTake, type EventExtractor, type Scores,
} from '../../tools/replay/score.ts'

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...kids)
  return e
}
const sleep0 = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

// ------------------------------------------------------------------ state
const params = new URLSearchParams(location.search)
let game: GameId = (params.get('game') as GameId) in GAMES ? (params.get('game') as GameId) : 'boxing'
let tab: 'record' | 'train' = params.get('tab') === 'train' ? 'train' : 'record'

let pipeline: PosePipeline | null = null
const overlay = createPoseOverlay($<HTMLCanvasElement>('overlay'))
let live: EventExtractor | null = null

let taking = false
let frames: PackedPose[] = []
let sets: Array<RecordingSegment & { live: number }> = []
let current: (RecordingSegment & { live: number }) | null = null
let startedAt = ''
let lastT = 0
let infSum = 0
let infN = 0
let fps = 0
let prevT = 0

const CAL_HINT: Record<string, string> = {
  'no-pose': 'No body found: step back so head and upper body are in view; add light in front of you.',
  'shoulders-hidden': 'Shoulders unclear: face the camera square-on; avoid a bright window behind you.',
  'too-close': 'Too close: step back to 1.5 to 2.5 m.',
  'hands-hidden': 'Fists not in view: raise the guard to chin height, both fists well inside the picture.',
  holding: 'Hold still with the guard up...',
  done: '',
}

// ------------------------------------------------------------------ header: games + tabs
function renderHeader(): void {
  const games = $('games')
  games.replaceChildren(...(Object.keys(GAMES) as GameId[]).map((id) => {
    const b = el('button', { textContent: GAMES[id].name, className: id === game ? 'on' : '' })
    b.onclick = () => { if (taking) return alert('Save or discard the take first.'); game = id; syncUrl(); renderAll() }
    return b
  }))
  for (const b of $('tabs').querySelectorAll<HTMLButtonElement>('button')) {
    b.classList.toggle('on', b.dataset.tab === tab)
    b.onclick = () => { tab = b.dataset.tab as typeof tab; syncUrl(); renderAll() }
  }
  $('gameNote').textContent = GAMES[game].detector ? '' : 'No detector yet for this game: record now, train later.'
  $('tab-record').hidden = tab !== 'record'
  $('tab-train').hidden = tab !== 'train'
}

function syncUrl(): void {
  history.replaceState(null, '', `?game=${game}&tab=${tab}`)
}

// ------------------------------------------------------------------ record tab
function gameTypes(): MotionLabel[] {
  return GAMES[game].labels.filter((l) => l !== 'idle')
}

function renderLabels(): void {
  $('labels').replaceChildren(...GAMES[game].labels.map((label) => {
    const b = el('button', { textContent: label, disabled: !taking || current !== null, className: current?.label === label ? 'on' : '' })
    b.title = GAMES[game].howTo[label] ?? ''
    b.onclick = () => startSet(label)
    b.onmouseenter = () => { $('howTo').textContent = `${label}: ${GAMES[game].howTo[label] ?? ''}` }
    return b
  }))
  $('howTo').textContent = current ? `${current.label}: ${GAMES[game].howTo[current.label] ?? ''}` : taking ? 'Pick what the player will do next.' : ''
}

function renderTake(): void {
  $<HTMLButtonElement>('take').disabled = taking || !pipeline
  $<HTMLButtonElement>('save').disabled = !taking
  $<HTMLButtonElement>('discard').disabled = !taking
  $<HTMLButtonElement>('mark').disabled = !current
  $<HTMLButtonElement>('end').disabled = !current
  const badge = $('badge')
  badge.textContent = !pipeline ? 'camera off' : taking ? (current ? `REC ${current.label} (${current.marks.length})` : 'REC') : 'ready'
  badge.className = `badge${taking ? ' rec' : ''}`
  const secs = taking && frames.length ? Math.round((lastT - (frames.find((f) => f)?.[0] ?? lastT)) / 1000) : 0
  $('takeInfo').textContent = taking
    ? `${frames.length} frames, ${secs} s. ${live?.calibration ? 'Calibrated.' : 'Hold guard still to calibrate first.'}`
    : pipeline ? 'Start a take, then have the player hold the guard still for 2 s.' : 'Start the camera first.'
  $('sets').replaceChildren(...[...sets, ...(current ? [current] : [])].map((s, i) => {
    const del = el('button', { textContent: 'Delete', disabled: s === current })
    del.onclick = () => { if (del.textContent !== 'Sure?') { del.textContent = 'Sure?'; setTimeout(() => (del.textContent = 'Delete'), 3000); return } sets.splice(i, 1); renderTake() }
    return el('tr', {},
      el('td', { textContent: s === current ? `${s.label} (recording)` : s.label }),
      el('td', { textContent: s === current ? '-' : String(s.reps) }),
      el('td', { textContent: String(s.marks.length) }),
      el('td', { textContent: s.label === 'idle' ? `${s.live} false` : String(s.live) }),
      el('td', {}, del))
  }))
  renderLabels()
}

function logEvent(text: string, cls = ''): void {
  const box = $('events')
  box.prepend(el('div', { textContent: `${new Date().toLocaleTimeString()}  ${text}`, className: cls }))
  while (box.childElementCount > 200) box.lastElementChild?.remove()
}

/**
 * The calibrator's own checks (src/pose/calibration.ts) on the current frame, in words, so it is clear which one fails:
 * both shoulders visible (> 0.5) and 0.03 < shoulder width < 0.5 of frame height; both wrists visible (>= 0.4) and
 * not within 2% of the frame edge.
 */
function calDiagnostics(frame: PoseFrame | null): { text: string; data: Record<string, unknown> } | null {
  if (!frame || !pipeline) return null
  const a = pipeline.videoWidth / Math.max(1, pipeline.videoHeight)
  const ls = frame.image[11]
  const rs = frame.image[12]
  const width = Math.hypot((ls.x - rs.x) * a, ls.y - rs.y)
  const wrist = (i: number) => {
    const w = frame.image[i]
    const edge = w.x <= 0.02 || w.x >= 0.98 || w.y <= 0.02 || w.y >= 0.98
    return { vis: +(w.visibility ?? 0).toFixed(2), x: +w.x.toFixed(2), y: +w.y.toFixed(2), edge, ok: (w.visibility ?? 0) >= 0.4 && !edge }
  }
  const L = wrist(15)
  const R = wrist(16)
  const shouldersOk = (ls.visibility ?? 0) > 0.5 && (rs.visibility ?? 0) > 0.5 && width >= 0.03
  const fmt = (n: string, w: ReturnType<typeof wrist>): string => `${n} fist ${w.ok ? 'OK' : w.edge ? 'AT EDGE (y ' + w.y + ')' : 'not seen (' + w.vis + ')'}`
  const text = `Shoulders ${shouldersOk ? 'OK' : `NOT OK (vis ${(ls.visibility ?? 0).toFixed(2)}/${(rs.visibility ?? 0).toFixed(2)})`}, ` +
    `size ${(width * 100).toFixed(0)}% of frame height (${width > 0.5 ? 'TOO CLOSE, max 50' : 'ok'}). ${fmt('Left', L)}. ${fmt('Right', R)}.`
  return { text, data: { shoulderVis: [ls.visibility, rs.visibility], shoulderWidth: +width.toFixed(3), left: L, right: R, aspect: +a.toFixed(2) } }
}

let lastReport = 0
/** Dev only: posts the calibration state to the dev server (no images), so a helper can read it from the terminal. */
function reportStatus(status: string, diag: ReturnType<typeof calDiagnostics>): void {
  const now = performance.now()
  if (now - lastReport < 1000) return
  lastReport = now
  void fetch('/__lab-status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ at: new Date().toISOString(), status, fps: Math.round(fps), inferenceMs: pipeline?.inferenceMs, video: pipeline ? [pipeline.videoWidth, pipeline.videoHeight] : null, ...(diag?.data ?? { pose: false }) }),
  }).catch(() => {})
}

function onFrame(frame: PoseFrame | null): void {
  if (frame) {
    if (prevT) fps = fps * 0.9 + (1000 / Math.max(1, frame.t - prevT)) * 0.1
    prevT = frame.t
    lastT = frame.t
  }
  overlay.draw(frame, false)
  if (taking) {
    frames.push(packPose(frame))
    infSum += pipeline!.inferenceMs
    infN++
  }
  if (live) {
    const types = gameTypes()
    for (const e of live.push(frame)) {
      if (!types.includes(e.type)) continue
      const hit = current !== null && current.label === e.type
      // Live count: correct detections in a motion set, any detection in an idle set (those are false triggers).
      if (current && (hit || current.label === 'idle')) current.live++
      logEvent(`${e.type}  (${e.detail})${current ? (hit ? '  ✓' : `  ✗ during ${current.label}`) : ''}`, current ? (hit ? 'ok' : 'bad') : '')
      if (e.type.startsWith('jab') || e.type === 'hook' || e.type === 'uppercut') overlay.flash(e.detail.endsWith('left') ? 'left' : 'right', e.type.toUpperCase())
    }
    const st = live.calibration ? 'done' : live.status
    $('calStatus').textContent = live.calibration ? `calibrated (${live.calibration.stance ?? 'orthodox'})` : `calibrating: ${st}`
    const diag = calDiagnostics(frame)
    $('calHint').textContent = `${CAL_HINT[st] ?? ''}${diag && !live.calibration ? `\n${diag.text}` : ''}`
    reportStatus(st, diag)
  }
  if (frames.length % 10 === 0 || !taking) {
    $('perf').textContent = `fps ${fps.toFixed(0)}   pose inference ${pipeline?.inferenceMs.toFixed(1) ?? '-'} ms   camera-to-app ${frame ? (performance.now() - frame.t).toFixed(0) : '-'} ms`
    if (taking) renderTake()
  }
}

async function startCamera(): Promise<void> {
  if (pipeline) return
  $('calStatus').textContent = 'starting camera...'
  try {
    const video = $<HTMLVideoElement>('video')
    pipeline = await startPosePipeline(video)
    overlay.resize(pipeline.videoWidth, pipeline.videoHeight)
    live = createEventExtractor(pipeline.videoWidth / pipeline.videoHeight)
    pipeline.subscribe(onFrame)
    $<HTMLButtonElement>('camera').textContent = 'Recalibrate'
    renderTake()
  } catch (err) {
    $('calStatus').textContent = `camera failed: ${String(err)}`
  }
}

function startTake(): void {
  if (!pipeline) return
  frames = []
  sets = []
  current = null
  infSum = 0
  infN = 0
  startedAt = new Date().toISOString()
  taking = true
  // Fresh extractor: it calibrates from the take's first frames, exactly like the replay will.
  live = createEventExtractor(pipeline.videoWidth / pipeline.videoHeight)
  logEvent('take started: hold the guard still for 2 s')
  renderTake()
}

function startSet(label: MotionLabel): void {
  if (!taking || current) return
  current = { label, startT: lastT || performance.now(), endT: 0, reps: 0, marks: [], live: 0 }
  logEvent(`set: ${label}`)
  renderTake()
}

function markRep(): void {
  if (!current) return
  current.marks.push(Math.round(lastT || performance.now()))
  renderTake()
}

function endSet(): void {
  if (!current) return
  current.endT = lastT || performance.now()
  let reps = 0
  if (current.label !== 'idle') {
    const answer = prompt(`How many ${current.label} reps were actually done?`, String(current.marks.length || 20))
    if (answer === null) return
    reps = Math.max(0, Math.round(Number(answer) || 0))
  }
  current.reps = reps
  sets.push(current)
  current = null
  renderTake()
}

async function saveTake(): Promise<void> {
  if (!taking) return
  if (current) endSet()
  if (current) return
  if (!sets.length && !confirm('No labelled sets in this take. Save anyway?')) return
  const rec: Recording = {
    version: RECORDING_VERSION,
    game,
    person: $<HTMLInputElement>('person').value.trim() || 'anon',
    distanceM: Number($<HTMLInputElement>('dist').value) || 0,
    lighting: $<HTMLInputElement>('light').value.trim(),
    note: '',
    recordedAt: startedAt,
    aspect: pipeline ? pipeline.videoWidth / Math.max(1, pipeline.videoHeight) : 4 / 3,
    inferenceMs: infN ? Math.round((infSum / infN) * 10) / 10 : 0,
    frames,
    segments: sets.map(({ live: _live, ...s }) => s),
  }
  const name = recordingFileName(rec)
  const body = JSON.stringify(rec)
  taking = false
  renderTake()
  try {
    const res = await fetch(`/__recordings?name=${encodeURIComponent(name)}`, { method: 'POST', body, headers: { 'content-type': 'application/json' } })
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
    const { file, bytes } = (await res.json()) as { file: string; bytes: number }
    logEvent(`saved ${file} (${Math.round(bytes / 1024)} KB, ${rec.segments.length} sets)`, 'ok')
  } catch (err) {
    const a = el('a', { href: URL.createObjectURL(new Blob([body], { type: 'application/json' })), download: name })
    a.click()
    URL.revokeObjectURL(a.href)
    logEvent(`server save failed (${String(err)}): downloaded ${name}, move it to recordings/`, 'bad')
  }
}

function discardTake(): void {
  if (!taking || !confirm('Discard this take?')) return
  taking = false
  current = null
  sets = []
  frames = []
  logEvent('take discarded')
  renderTake()
}

$('camera').onclick = () => {
  if (!pipeline) return void startCamera()
  live = createEventExtractor(pipeline.videoWidth / pipeline.videoHeight)
  logEvent('recalibrating: hold the guard still')
}
$('take').onclick = startTake
$('save').onclick = () => void saveTake()
$('discard').onclick = discardTake
$('mark').onclick = markRep
$('end').onclick = endSet
window.addEventListener('keydown', (e) => {
  if (!e.altKey || e.repeat || tab !== 'record') return
  if (e.code === 'Space') markRep()
  else if (e.code === 'Enter') endSet()
  else if (e.code === 'KeyS') void saveTake()
  else return
  e.preventDefault()
})

// ------------------------------------------------------------------ train tab
interface Loaded { file: string; bytes: number; rec: Recording }
let loaded: Loaded[] = []
const selected = new Set<string>()
let overrides: Partial<BoxingDetectorConfig> = {}

async function loadRecordings(): Promise<void> {
  $('recInfo').textContent = 'loading...'
  try {
    const list = (await (await fetch('/__recordings')).json()) as Array<{ file: string; bytes: number }>
    const out: Loaded[] = []
    for (const f of list) {
      try {
        const rec = parseRecording(await (await fetch(`/__recordings/${encodeURIComponent(f.file)}`)).text())
        out.push({ file: f.file, bytes: f.bytes, rec })
      } catch { /* skip unreadable */ }
    }
    loaded = out
    for (const l of loaded) selected.add(l.file)
    $('recInfo').textContent = `${loaded.length} recordings in recordings/`
  } catch (err) {
    $('recInfo').textContent = `could not list recordings (${String(err)}). Is this the dev server?`
  }
  renderTrain()
}

function gameRecs(): Loaded[] {
  return loaded.filter((l) => gameOf(l.rec) === game)
}

function renderTrain(): void {
  const recs = gameRecs()
  $('recs').replaceChildren(...(recs.length ? recs.map((l) => {
    const cb = el('input', { type: 'checkbox', checked: selected.has(l.file) })
    cb.onchange = () => { if (cb.checked) selected.add(l.file); else selected.delete(l.file) }
    const segs = l.rec.segments.map((s) => `${s.label}×${s.reps}`).join(' ')
    return el('tr', {}, el('td', {}, cb, ` ${l.file}`), el('td', { textContent: l.rec.person }), el('td', { textContent: `${l.rec.distanceM} m` }),
      el('td', { textContent: l.rec.lighting }), el('td', { textContent: segs }), el('td', { textContent: `${Math.round(l.bytes / 1024)} KB` }))
  }) : [el('tr', {}, el('td', { textContent: `No ${GAMES[game].name} recordings yet. Record some in the Record tab.`, colSpan: 6 }))]))
  const hasDet = GAMES[game].detector
  $('noDetector').hidden = hasDet
  $('scoreCard').hidden = !hasDet
  $('tuneCard').hidden = game !== 'boxing'
  renderParams()
}

function renderParams(): void {
  $('params').replaceChildren(...BOXING_TUNABLES.map((t) => {
    const def = DEFAULT_BOXING_CONFIG[t.key] as number
    const input = el('input', { type: 'number', step: String(t.step), value: String(overrides[t.key] ?? def) })
    input.style.color = overrides[t.key] !== undefined && overrides[t.key] !== def ? 'var(--warn)' : ''
    input.onchange = () => {
      const v = Number(input.value)
      if (!Number.isFinite(v) || v === def) delete overrides[t.key]
      else Object.assign(overrides, { [t.key]: v })
      renderParams()
    }
    return el('label', { title: `${t.key} (default ${def})` }, el('span', { textContent: t.what }), input)
  }))
}

function selectedRecs(): Recording[] {
  return gameRecs().filter((l) => selected.has(l.file)).map((l) => l.rec)
}

function scoreTable(s: Scores, compare?: Scores): HTMLTableElement {
  const before = compare ? new Map(scoreRows(compare).map((r) => [r.label, r])) : null
  const head = ['Motion', 'Reps', 'Detected', 'Recall', 'Precision', 'False', 'FP % reps', 'Latency ms', 'Named as']
  return el('table', {},
    el('thead', {}, el('tr', {}, ...head.map((h) => el('th', { textContent: h })))),
    el('tbody', {}, ...scoreRows(s).map((r) => {
      const b = before?.get(r.label)
      const was = (now: string, then?: string): string => (then !== undefined && then !== now ? `${then} → ${now}` : now)
      if (!r.scored) return el('tr', {}, el('td', { textContent: r.label }), el('td', { textContent: String(r.reps) }), el('td', { textContent: 'no detector yet', colSpan: 7 }))
      return el('tr', {},
        el('td', { textContent: `${r.ok ? '✓' : '⚠'} ${r.label}`, className: r.ok ? 'ok' : 'warn' }),
        el('td', { textContent: String(r.reps) }), el('td', { textContent: was(String(r.tp), b && String(b.tp)) }),
        el('td', { textContent: was(r.recall, b?.recall) }), el('td', { textContent: was(r.precision, b?.precision) }),
        el('td', { textContent: was(String(r.fp), b && String(b.fp)) }), el('td', { textContent: was(r.fpRate, b?.fpRate) }),
        el('td', { textContent: r.latency }), el('td', { textContent: r.kinds }))
    })))
}

function renderScores(s: Scores, label: string, compare?: Scores): HTMLElement {
  const conf = [...s.confusion].map(([seg, row]) => `${seg}: ${[...row].map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing'}`).join('\n')
  return el('div', {},
    el('h3', { textContent: label, className: 'muted' }),
    scoreTable(s, compare),
    el('div', { className: 'muted', textContent: `Idle: ${idleSummary(s)}. Between sets (not scored): ${s.unlabelled}.` }),
    el('details', {}, el('summary', { textContent: 'What fired during each set' }), el('pre', { textContent: conf })))
}

async function runScore(): Promise<void> {
  const recs = selectedRecs()
  if (!recs.length) { $('scoreInfo').textContent = 'select some recordings first'; return }
  $('scoreInfo').textContent = 'scoring...'
  await sleep0()
  const types = gameTypes()
  const t0 = performance.now()
  const opts = game === 'boxing' ? { boxing: overrides } : {}
  const now = scoreAll(recs, opts, types)
  const base = Object.keys(overrides).length && game === 'boxing' ? scoreAll(recs, {}, types) : undefined
  const out: HTMLElement[] = [renderScores(now, base ? 'With your overrides (defaults → now)' : 'All selected', base)]
  if ($<HTMLInputElement>('byPerson').checked) {
    const people = [...new Set(recs.map((r) => r.person))]
    for (const p of people) {
      const s = emptyScores()
      for (const r of recs.filter((x) => x.person === p)) scoreTake(r, replayTake(r, opts), s, types)
      out.push(renderScores(s, `Person: ${p}`))
    }
  }
  $('scoreOut').replaceChildren(...out)
  $('scoreInfo').textContent = `${recs.length} takes in ${Math.round(performance.now() - t0)} ms. Score ${objective(now, types).toFixed(3)} (mean F1 minus idle penalty). Target: ✓ = ≥90% detected and <5% false.`
}

async function runAutotune(): Promise<void> {
  const recs = selectedRecs()
  if (!recs.length) { $('tuneInfo').textContent = 'select some recordings first'; return }
  const btn = $<HTMLButtonElement>('autotune')
  btn.disabled = true
  const log = $('tuneLog')
  log.hidden = false
  log.textContent = ''
  const types = gameTypes()
  const baseline = scoreAll(recs, { boxing: overrides }, types)
  let n = 0
  const res = await autoTuneBoxing(recs, types, overrides, Math.max(1, Number($<HTMLInputElement>('rounds').value) || 2), async (s) => {
    n++
    $('tuneInfo').textContent = `round ${s.round}, trial ${n}: ${s.key} = ${s.value} -> ${s.objective.toFixed(3)}`
    if (s.accepted) log.textContent += `kept ${s.key} = ${s.value} (score ${s.objective.toFixed(3)})\n`
    await sleep0()
  })
  overrides = res.config
  for (const k of Object.keys(overrides) as Array<keyof BoxingDetectorConfig>) if (overrides[k] === DEFAULT_BOXING_CONFIG[k]) delete overrides[k]
  $('tuneInfo').textContent = `done: score ${res.before.toFixed(3)} -> ${res.after.toFixed(3)} after ${n} trials`
  if (!log.textContent) log.textContent = 'No single-step change improved the score.\n'
  log.textContent += `\nOverrides vs defaults:\n${JSON.stringify(overrides, null, 2)}`
  renderParams()
  $('scoreOut').replaceChildren(renderScores(scoreAll(recs, { boxing: overrides }, types), 'After auto-tune (before → after)', baseline))
  btn.disabled = false
}

$('reload').onclick = () => void loadRecordings()
$('score').onclick = () => void runScore()
$('autotune').onclick = () => void runAutotune()
$('resetParams').onclick = () => { overrides = {}; renderParams() }
$('copyCfg').onclick = () => {
  const text = JSON.stringify(overrides, null, 2)
  void navigator.clipboard?.writeText(text)
  $('tuneInfo').textContent = `copied: ${text.replace(/\s+/g, ' ')}`
}
$<HTMLInputElement>('all').onchange = (e) => {
  const on = (e.target as HTMLInputElement).checked
  for (const l of gameRecs()) { if (on) selected.add(l.file); else selected.delete(l.file) }
  renderTrain()
}

// ------------------------------------------------------------------ boot
function renderAll(): void {
  renderHeader()
  renderTake()
  if (tab === 'train') {
    if (!loaded.length) void loadRecordings()
    else renderTrain()
  }
}
renderAll()
