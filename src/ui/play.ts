// Preview: Rohan's src/main.ts with the Kinetic HUD swapped in (the only change). Dev only.
import '../style.css'
import { createBodyTracker } from '../pose/body.ts'
import type { BodyTracker } from '../pose/body.ts'
import { createCalibrator, defaultCalibration } from '../pose/calibration.ts'
import type { Calibrator } from '../pose/calibration.ts'
import { createPoseOverlay } from '../pose/overlay.ts'
import { startPosePipeline } from '../pose/pipeline.ts'
import type { PosePipeline } from '../pose/pipeline.ts'
import { StartupError } from '../pose/types.ts'
import type { Calibration, PoseFrame } from '../pose/types.ts'
import { BOXING_FILTER, createBoxingDetector } from '../sports/boxing/detector.ts'
import { createBoxingEngine } from '../sports/boxing/engine.ts'
import { createKineticHud } from './KineticHud.ts'
import { createKeyboardFallback } from '../sports/boxing/keyboard.ts'
import { createBoxingScene } from '../sports/boxing/scene.ts'
import { createTelemetry } from '../sports/boxing/telemetry.ts'

type AppState = 'start' | 'loading' | 'calibrating' | 'fighting' | 'ended' | 'error'

/** Longest frame step fed to the game, ms (a hidden tab must not jump the round). */
const MAX_DT_MS = 50

function el<T extends HTMLElement>(selector: string, type: new () => T): T {
  const node = document.querySelector(selector)
  if (!(node instanceof type)) throw new Error(`Kinetic Ring: missing ${selector} in index.html`)
  return node
}

const app = el('#app', HTMLElement)
const video = el('#webcam', HTMLVideoElement)
const overlayCanvas = el('#overlay', HTMLCanvasElement)
const ui = el('#ui', HTMLDivElement)

const arena = document.createElement('div')
arena.id = 'arena'
app.prepend(arena)

const scene = createBoxingScene(arena)
const hud = createKineticHud(ui)
const telemetry = createTelemetry()
const detector = createBoxingDetector()
const engine = createBoxingEngine({ hud, telemetry, detector })
const keyboard = createKeyboardFallback()
const overlay = createPoseOverlay(overlayCanvas)

let state: AppState = 'start'
let pipeline: PosePipeline | null = null
let cameraStarting = false
let calibrator: Calibrator | null = null
let bodyTracker: BodyTracker | null = null
let aspect = 16 / 9
let engineReady = false
let frames = 0

function setState(next: AppState): void {
  state = next
  document.body.dataset.state = next
}

// Test hooks: count telemetry events on the page.
let eventCount = 0
let punchCount = 0
window.addEventListener('motion-event', (e) => {
  eventCount++
  const detail: unknown = e instanceof CustomEvent ? e.detail : null
  if (typeof detail === 'object' && detail !== null && 'event_type' in detail && detail.event_type === 'PUNCH') {
    punchCount++
  }
  document.body.dataset.events = String(eventCount)
  document.body.dataset.punches = String(punchCount)
})
document.body.dataset.events = '0'
document.body.dataset.punches = '0'
document.body.dataset.frames = '0'

function beginFight(calibration: Calibration): void {
  if (!engineReady) {
    engine.init(scene, calibration)
    engineReady = true
  }
  engine.startRound()
  hud.showFight()
  setState('fighting')
}

function again(): void {
  engine.startRound()
  hud.showFight()
  setState('fighting')
}

engine.onRoundEnd((result) => {
  setState('ended')
  hud.showRoundEnd(result, again, null)
})

function onFrame(frame: PoseFrame | null): void {
  frames++
  overlay.draw(frame, state === 'fighting' && engine.debug.guard === 1)
  if (state === 'calibrating' && calibrator) {
    const p = calibrator.push(frame, aspect)
    hud.showCalibration(p.progress, p.status)
    if (p.status === 'done' && p.calibration) {
      bodyTracker = createBodyTracker(p.calibration, BOXING_FILTER)
      beginFight(p.calibration)
    }
  } else if ((state === 'fighting' || state === 'ended') && bodyTracker) {
    engine.onPoseFrame(bodyTracker.push(frame))
  }
}

async function startCamera(): Promise<void> {
  if (cameraStarting || pipeline) return
  cameraStarting = true
  setState('loading')
  hud.showLoading('Starting camera and pose tracker')
  try {
    const p = await startPosePipeline(video)
    pipeline = p
    overlay.resize(p.videoWidth, p.videoHeight)
    document.body.dataset.delegate = p.delegate
    aspect = p.videoWidth / p.videoHeight
    p.subscribe(onFrame)
    // The player may have switched to keyboard play while the camera was loading.
    if (state === 'loading') {
      calibrator = createCalibrator()
      setState('calibrating')
      hud.showCalibration(0, 'no-pose')
    }
  } catch (err) {
    console.error('Kinetic Ring: startup failed', err)
    if (state === 'loading') {
      const kind = err instanceof StartupError ? err.kind : 'tracker-failed'
      setState('error')
      hud.showError(kind, () => void startCamera(), startKeyboard)
    }
  } finally {
    cameraStarting = false
  }
}

function startKeyboard(): void {
  keyboard.setEnabled(true)
  hud.setKeyboardMode(true)
  if (state === 'fighting' || state === 'ended') return
  beginFight(defaultCalibration(16 / 9))
}

// One animation loop for the whole app.
let last = performance.now()
let fps = 0
let statAcc = 0
let statFrames = 0
function loop(now: number): void {
  const dt = Math.min(Math.max(now - last, 0), MAX_DT_MS)
  last = now
  if (keyboard.enabled) engine.onActions(keyboard.poll())
  engine.update(dt)
  scene.render()

  statFrames++
  statAcc += dt
  if (statAcc >= 1000) {
    fps = Math.round((statFrames * 1000) / statAcc)
    statAcc = 0
    statFrames = 0
    document.body.dataset.frames = String(frames)
  }
  hud.setDebug({
    ...engine.debug,
    fps,
    inferenceMs: pipeline ? Math.round(pipeline.inferenceMs * 10) / 10 : 0,
    delegate: pipeline ? pipeline.delegate : 'none',
  })
  requestAnimationFrame(loop)
}

function resize(): void {
  scene.resize(innerWidth, innerHeight)
}
window.addEventListener('resize', resize)
resize()

window.addEventListener('keydown', (e) => {
  if (e.repeat) return
  if (e.code === 'KeyD') {
    if (state === 'start' || state === 'error' || state === 'calibrating' || state === 'loading') {
      startKeyboard()
    } else {
      hud.setKeyboardMode(keyboard.toggle())
    }
  } else if (e.code === 'Backquote') {
    hud.toggleDebug()
  } else if (e.code === 'KeyR' && state === 'ended') {
    again()
  }
})

window.addEventListener('pagehide', () => {
  pipeline?.stop()
  keyboard.dispose()
  engine.dispose()
  scene.dispose()
})

setState('start')
hud.showStart(() => void startCamera(), startKeyboard)
requestAnimationFrame(loop)
