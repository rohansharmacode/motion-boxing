// TEMPORARY standalone dev boot for Reflex Keeper (goalkeeper.html).
// Remove together with goalkeeper.html and dev-camera.ts once main.ts has a sport switcher
// and the shared pose pipeline (src/pose) drives this sport.
//
// Query flags: ?auto=mouse skips the start screen straight into a mouse-mode shootout (handy for
// headless screenshots); ?auto=camera starts the camera path; ?debug opens the debug panel.
//
// Keys: D toggles mouse mode, R restarts the shootout, ` (Backquote) toggles the debug panel.

import { createKeeperScene } from './scene.ts'
import { createKeeperEngine } from './engine.ts'
import { createKeeperTelemetry } from './telemetry.ts'
import { createKeeperHud } from './hud.ts'
import { createKeeperInput } from './input.ts'
import { startDevCamera } from './dev-camera.ts'
import type { DevCamera } from './dev-camera.ts'
import { KICKS_PER_SHOOTOUT } from './types.ts'
import type { Calibration, KeeperMotionEvent, KickResult } from './types.ts'

function must<T extends HTMLElement>(sel: string): T {
  const node = document.querySelector<T>(sel)
  if (!node) throw new Error(`goalkeeper dev: missing ${sel}`)
  return node
}

const stage = must<HTMLElement>('#stage')
const ui = must<HTMLElement>('#ui')
const video = must<HTMLVideoElement>('#webcam')

const scene = createKeeperScene()
stage.prepend(scene.canvas)
const hud = createKeeperHud(ui)
const telemetry = createKeeperTelemetry()
const engine = createKeeperEngine({ telemetry })

const input = createKeeperInput({
  canvas: scene.canvas,
  screenToGoal: (x, y) => scene.screenToGoal(x, y),
  onToggle: (on) => {
    hud.setInputMode(on ? 'mouse' : 'camera')
    if (!on && !camera && initialized) hud.callout('NO CAMERA · PRESS D', 'info')
  },
})

let initialized = false
let camera: DevCamera | null = null
let starting = false
let debugOpen = false

// ---------- sizing ----------

function resize(): void {
  const r = stage.getBoundingClientRect()
  scene.resize(Math.max(1, Math.round(r.width)), Math.max(1, Math.round(r.height)))
}
resize()
const ro = new ResizeObserver(resize)
ro.observe(stage)
window.addEventListener('resize', resize)

// ---------- engine wiring ----------

function resultCallout(r: KickResult): void {
  if (r.outcome === 'goal') hud.callout('GOAL', 'bad')
  else if (r.punch) hud.callout('PUNCHED CLEAR!', 'good')
  else hud.callout('SAVED!', 'good')
}

engine.onKickResult((r) => {
  hud.setScoreboard(engine.results, KICKS_PER_SHOOTOUT)
  resultCallout(r)
})

engine.onStrikerPhase((phase, kick) => {
  if (phase === 'idle') {
    hud.setScoreboard(engine.results, KICKS_PER_SHOOTOUT)
    hud.callout(kick === KICKS_PER_SHOOTOUT - 1 ? 'LAST KICK' : 'GET READY', 'info')
  }
})

engine.onShootoutEnd((result) => {
  hud.showEnd(result, () => startShootout())
})

function begin(calibration: Calibration | null): void {
  if (!initialized) {
    engine.init(scene, calibration)
    initialized = true
  }
  startShootout()
}

function startShootout(): void {
  hud.setScoreboard([], KICKS_PER_SHOOTOUT)
  hud.showPlay()
  engine.startShootout()
}

// ---------- camera / mouse paths ----------

async function startCamera(): Promise<void> {
  if (starting) return
  starting = true
  camera?.stop()
  camera = null
  hud.setInputMode('camera')
  input.setMouse(false)
  hud.showLoading('Starting camera…')
  try {
    let begun = false
    camera = await startDevCamera(
      video,
      (body) => {
        if (initialized) engine.onPoseFrame(body)
      },
      (progress, status) => {
        if (begun) return
        if (status === 'done') {
          begun = true
          hud.showCalibration(1, 'done')
          window.setTimeout(() => begin(camera?.calibration() ?? null), 450)
          return
        }
        hud.showCalibration(progress, status)
      },
    )
    video.classList.add('gk-live')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[goalkeeper dev] camera failed', err)
    hud.showError(message, () => void startCamera(), startMouse)
  } finally {
    starting = false
  }
}

function startMouse(): void {
  input.setMouse(true)
  hud.setInputMode('mouse')
  begin(camera?.calibration() ?? null)
}

hud.showStart(() => void startCamera(), startMouse)

// ---------- keys ----------

window.addEventListener('keydown', (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
  if (e.code === 'Backquote') {
    hud.toggleDebug()
    debugOpen = !debugOpen
  } else if (e.code === 'KeyR' && initialized) {
    startShootout()
  }
})

// ---------- telemetry visibility ----------

window.addEventListener('motion-event', (e) => {
  const detail = (e as CustomEvent<KeeperMotionEvent>).detail
  console.debug(`[motion-event] ${detail?.event_type ?? '?'}`, detail)
})

window.addEventListener('pagehide', () => {
  engine.flushTelemetry()
  camera?.stop()
})

// ---------- frame loop ----------

let last = performance.now()
let fps = 60

function frame(now: number): void {
  requestAnimationFrame(frame)
  const dt = Math.min(Math.max(now - last, 0), 250)
  last = now
  if (dt > 0) fps += (1000 / dt - fps) * 0.05

  engine.setPointer(input.mouseOn ? input.target() : null)
  engine.update(dt)
  scene.update(dt)
  scene.render()

  if (debugOpen) {
    hud.setDebug({
      fps: Math.round(fps),
      input: input.mouseOn ? 'mouse' : camera ? 'camera' : 'none',
      phase: engine.phase,
      kickIndex: engine.kickIndex,
      ...engine.debug,
    })
  }
}
requestAnimationFrame(frame)

// ---------- query flags ----------

const params = new URLSearchParams(location.search)
if (params.has('debug')) {
  hud.toggleDebug()
  debugOpen = true
}
const auto = params.get('auto')
if (auto === 'mouse') startMouse()
else if (auto === 'camera') void startCamera()
