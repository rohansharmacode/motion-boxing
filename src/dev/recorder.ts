// Dev-only motion recorder (?record=1 on the dev server). Loaded by pose/pipeline.ts once the camera runs, so it
// works in every sport without touching game, HUD or home code. It listens to the shared pose pipeline,
// records raw frames for a "take", and lets an operator label what the player is doing. Saved takes go to
// /recordings via the dev server (vite.config.ts), as gzipped JSON. See recordings/README.md for the protocol.
//
// Keys use Alt so the games ignore them: Alt+Space marks a rep, Alt+Enter ends the segment, Alt+S saves the take.
import type { PosePipeline } from '../pose/pipeline.ts'
import type { PoseFrame } from '../pose/types.ts'
import {
  MOTION_LABELS, RECORDING_VERSION, packPose, recordingFileName,
  type MotionLabel, type PackedPose, type Recording, type RecordingSegment,
} from './recordingFormat.ts'

let attached = false

export function attachRecorder(pipeline: PosePipeline): void {
  if (attached) return
  attached = true

  const panel = document.createElement('div')
  panel.style.cssText =
    'position:fixed;right:8px;bottom:8px;z-index:2147483647;width:330px;padding:10px;border-radius:10px;' +
    'background:rgba(10,14,28,.92);color:#e6ecff;font:12px/1.35 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.4)'
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center"><b>Motion recorder</b><span data-k="state">idle</span></div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;margin:6px 0">
      <input data-k="person" placeholder="person" />
      <input data-k="dist" placeholder="dist m" value="1.5" />
      <input data-k="light" placeholder="lighting" value="room" />
    </div>
    <div style="display:flex;gap:4px"><button data-k="take">Start take</button><button data-k="save" disabled>Save take (Alt+S)</button></div>
    <div data-k="labels" style="display:flex;flex-wrap:wrap;gap:3px;margin:6px 0"></div>
    <div style="display:flex;gap:4px"><button data-k="mark" disabled>Mark rep (Alt+Space)</button><button data-k="end" disabled>End segment (Alt+Enter)</button></div>
    <div data-k="info" style="margin-top:6px;white-space:pre-wrap;color:#9fb0dd"></div>`
  for (const el of panel.querySelectorAll<HTMLElement>('input,button')) {
    el.style.cssText = 'font:inherit;padding:3px 6px;border-radius:5px;border:1px solid #39456b;background:#1b2440;color:inherit;min-width:0'
  }
  document.body.append(panel)
  const q = <T extends HTMLElement>(k: string): T => panel.querySelector(`[data-k="${k}"]`) as T

  let frames: PackedPose[] = []
  let segments: RecordingSegment[] = []
  let seg: RecordingSegment | null = null
  let taking = false
  let lastT = 0
  let infSum = 0
  let infN = 0
  let poseSeen = 0
  let startedAt = ''

  const labelButtons = new Map<MotionLabel, HTMLButtonElement>()
  for (const label of MOTION_LABELS) {
    const b = document.createElement('button')
    b.textContent = label
    b.disabled = true
    b.style.cssText = 'font:inherit;padding:2px 5px;border-radius:5px;border:1px solid #39456b;background:#1b2440;color:inherit'
    b.onclick = () => startSegment(label)
    labelButtons.set(label, b)
    q('labels').append(b)
  }

  function render(): void {
    q('state').textContent = taking ? (seg ? `REC ${seg.label}` : 'REC (no label)') : 'idle'
    q('state').style.color = taking ? '#ff6b6b' : '#9fb0dd'
    q<HTMLButtonElement>('take').disabled = taking
    q<HTMLButtonElement>('save').disabled = !taking
    q<HTMLButtonElement>('mark').disabled = !seg
    q<HTMLButtonElement>('end').disabled = !seg
    for (const [label, b] of labelButtons) {
      b.disabled = !taking || seg !== null
      b.style.background = seg?.label === label ? '#c0392b' : '#1b2440'
    }
    const secs = frames.length && lastT ? ((lastT - (frames.find((f) => f)?.[0] ?? lastT)) / 1000).toFixed(0) : '0'
    q('info').textContent = taking
      ? `${frames.length} frames (${secs} s), pose in ${poseSeen}\n` +
        (seg ? `${seg.label}: ${seg.marks.length} reps marked\n` : 'Hold guard still 2 s first (replay calibrates from it), then pick a label.\n') +
        segments.map((s) => `  ${s.label} x${s.reps}${s.marks.length ? ` (${s.marks.length} marked)` : ''}`).join('\n')
      : 'Start a take, hold guard 2 s, then label each set of reps.'
  }

  function onFrame(f: PoseFrame | null): void {
    if (!taking) return
    if (f) { lastT = f.t; poseSeen++ }
    frames.push(packPose(f))
    infSum += pipeline.inferenceMs
    infN++
    if (frames.length % 15 === 0) render()
  }
  pipeline.subscribe(onFrame)

  function startTake(): void {
    frames = []
    segments = []
    seg = null
    poseSeen = 0
    infSum = 0
    infN = 0
    startedAt = new Date().toISOString()
    taking = true
    render()
  }

  function startSegment(label: MotionLabel): void {
    if (!taking || seg) return
    seg = { label, startT: lastT || performance.now(), endT: 0, reps: 0, marks: [] }
    render()
  }

  function mark(): void {
    if (!seg) return
    seg.marks.push(Math.round(lastT || performance.now()))
    render()
  }

  function endSegment(): void {
    if (!seg) return
    seg.endT = lastT || performance.now()
    const guess = seg.label === 'idle' ? 0 : seg.marks.length || 20
    const answer = seg.label === 'idle' ? '0' : prompt(`How many ${seg.label} reps were actually done?`, String(guess))
    if (answer === null) return // keep the segment open
    seg.reps = Math.max(0, Math.round(Number(answer) || 0))
    segments.push(seg)
    seg = null
    render()
  }

  async function save(): Promise<void> {
    if (!taking) return
    if (seg) endSegment()
    if (seg) return
    const rec: Recording = {
      version: RECORDING_VERSION,
      person: q<HTMLInputElement>('person').value.trim() || 'anon',
      distanceM: Number(q<HTMLInputElement>('dist').value) || 0,
      lighting: q<HTMLInputElement>('light').value.trim(),
      note: '',
      recordedAt: startedAt,
      aspect: pipeline.videoWidth / Math.max(1, pipeline.videoHeight),
      inferenceMs: infN ? Math.round((infSum / infN) * 10) / 10 : 0,
      frames,
      segments,
    }
    const name = recordingFileName(rec)
    const body = JSON.stringify(rec)
    taking = false
    render()
    try {
      const res = await fetch(`/__recordings?name=${encodeURIComponent(name)}`, { method: 'POST', body, headers: { 'content-type': 'application/json' } })
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
      const { file, bytes } = (await res.json()) as { file: string; bytes: number }
      q('info').textContent = `Saved ${file} (${(bytes / 1024).toFixed(0)} KB, ${segments.length} segments).`
    } catch (err) {
      // No dev-server endpoint (e.g. vite preview): download instead.
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }))
      a.download = name
      a.click()
      URL.revokeObjectURL(a.href)
      q('info').textContent = `Server save failed (${String(err)}); downloaded ${name}. Move it to recordings/.`
    }
  }

  q('take').onclick = startTake
  q('save').onclick = () => void save()
  q('mark').onclick = mark
  q('end').onclick = endSegment
  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.altKey || e.repeat) return
      if (e.code === 'Space') mark()
      else if (e.code === 'Enter') endSegment()
      else if (e.code === 'KeyS') void save()
      else return
      e.preventDefault()
      e.stopPropagation()
    },
    true,
  )
  render()
}
