// Aero Bow entry for the shell: startArchery(ctx) builds the game inside ctx.host and returns a
// GameSession. Camera path uses the shared PosePipeline + calibrator + body tracker from src/pose;
// mouse path (D toggles any time) needs no camera. Research doc section 3 (Sport 3) and 4.
import { startPosePipeline } from '../../pose/pipeline.ts'
import type { PosePipeline } from '../../pose/pipeline.ts'
import { createCalibrator } from '../../pose/calibration.ts'
import { createBodyTracker } from '../../pose/body.ts'
import type { BodyTracker } from '../../pose/body.ts'
import { StartupError } from '../../pose/types.ts'
import type { StartupErrorKind } from '../../pose/types.ts'
import type { GameContext, GameSession } from '../../shell/types.ts'
import { createSfx } from '../../shell/sfx.ts'
import type { Sfx } from '../../shell/sfx.ts'
import { ARCHERY_TRACKER_FILTER } from './detector.ts'
import { createArcheryEngine } from './engine.ts'
import { createArcheryHud } from './hud.ts'
import { createArcheryInput } from './input.ts'
import { createArcheryScene } from './scene.ts'
import { createArcherySfx } from './sfx.ts'
import { createArcheryTelemetry } from './telemetry.ts'
import { ARROWS_PER_ROUND, TARGET_CENTER, WIND_FIRST_ARROW } from './types.ts'
import type { ArcheryPhase, Calibration } from './types.ts'

/** Pause on the "Ready!" calibration screen before the first arrow, ms. */
const READY_PAUSE_MS = 450
/** Longest frame step fed to the game, ms (a hidden tab must not jump an arrow across the range). */
const MAX_DT_MS = 100
/** Round total that counts as a win (shell records and the end sting). */
const WIN_TOTAL = 35
/** Wind acceleration that plays the wind loop at full level, m/s^2. */
const WIND_FULL = 4

const CAMERA_COPY: Record<StartupErrorKind, string> = {
  'camera-denied': 'Camera access was blocked. Allow it in the address bar, then retry.',
  'camera-not-found': 'No camera found. Plug one in and retry.',
  'camera-in-use': 'The camera is busy in another app or tab. Close it and retry.',
  'camera-unsupported': 'This browser cannot use the camera here (it needs https or localhost).',
  'camera-other': 'The camera could not start.',
  'tracker-failed': 'The pose tracker failed to load. Check your connection and retry.',
}

let uiSfx: Sfx | null = null

export interface ArcheryOptions {
  /** Skip the start screen: 'mouse' or 'camera'. */
  auto?: 'mouse' | 'camera'
  /** Open the debug panel. */
  debug?: boolean
  /** Running inside the shell, which draws its own Home pill. Default true; archery.html passes false. */
  embedded?: boolean
}

export async function startArchery(ctx: GameContext, opts: ArcheryOptions = {}): Promise<GameSession> {
  if (ctx.signal.aborted) return { dispose() {} }

  // ---------- DOM ----------
  const root = document.createElement('div')
  const embedded = opts.embedded !== false
  root.className = embedded ? 'ar-root ar-page ar-embedded' : 'ar-root ar-page'
  const stage = document.createElement('div')
  stage.className = 'ar-stage'
  const video = document.createElement('video')
  video.className = 'ar-webcam'
  video.playsInline = true
  video.muted = true
  const ui = document.createElement('div')
  ui.className = 'ar-ui'
  root.append(stage, ui)
  ctx.host.append(root)

  uiSfx ??= createSfx() // shell sfx has no dispose: share one AudioContext across launches
  const sfx = createArcherySfx()
  const scene = createArcheryScene()
  stage.append(scene.canvas, video)
  const hud = createArcheryHud(ui, {
    cornerHome: !embedded,
    onHome: () => {
      uiSfx?.back()
      ctx.exit()
    },
    onButton: () => uiSfx?.select(),
  })
  const telemetry = createArcheryTelemetry()
  const engine = createArcheryEngine({ telemetry })

  let disposed = false
  let initialized = false
  let pipeline: PosePipeline | null = null
  let ownsPipeline = false
  let unsubscribe: (() => void) | null = null
  let tracker: BodyTracker | null = null
  let starting = false
  let debugOpen = false
  let muted = false
  let inStartMouse = false
  let windLevel = -1
  const timers = new Set<number>()

  const later = (ms: number, fn: () => void): void => {
    const id = window.setTimeout(() => {
      timers.delete(id)
      if (!disposed) fn()
    }, ms)
    timers.add(id)
  }

  const input = createArcheryInput({
    canvas: scene.canvas,
    onToggle: (on) => {
      hud.setInputMode(on ? 'mouse' : 'camera')
      // D on the start screen starts a mouse game (startMouse itself also lands here: skip that).
      if (on && !initialized && !inStartMouse && !starting) startMouse()
      else if (!on && !tracker && initialized) hud.callout('NO CAMERA · PRESS D', 'info')
    },
  })

  // ---------- sizing ----------
  function resize(): void {
    const r = stage.getBoundingClientRect()
    scene.resize(Math.max(1, Math.round(r.width)), Math.max(1, Math.round(r.height)))
  }
  const ro = new ResizeObserver(resize)
  ro.observe(stage)
  resize()

  // ---------- engine wiring ----------
  function phaseCallout(phase: ArcheryPhase, arrow: number): void {
    if (phase !== 'nock') return
    hud.setScoreboard(engine.shots, ARROWS_PER_ROUND)
    sfx.nock()
    if (arrow === WIND_FIRST_ARROW) hud.callout('WIND! AIM UPWIND', 'info')
    else if (arrow === ARROWS_PER_ROUND - 1) hud.callout('LAST ARROW', 'info')
    else hud.callout(`ARROW ${arrow + 1}`, 'info')
  }
  engine.onPhase(phaseCallout)

  engine.onRelease((info) => {
    sfx.setDraw(0)
    sfx.twang(info.tension)
  })

  engine.onShot((r) => {
    hud.showShot(r)
    hud.setScoreboard(engine.shots, ARROWS_PER_ROUND)
    if (r.score === 0) {
      sfx.miss()
    } else {
      sfx.hit(r.score)
      if (r.bullseye) sfx.cheer()
    }
  })

  engine.onRoundEnd((result) => {
    sfx.setDraw(0)
    sfx.setWind(0)
    windLevel = 0
    sfx.fanfare(result.total >= WIN_TOTAL)
    hud.showEnd(result, () => startRound())
  })

  function begin(calibration: Calibration | null): void {
    if (disposed) return
    engine.init(scene, calibration)
    initialized = true
    startRound()
  }

  function startRound(): void {
    hud.setScoreboard([], ARROWS_PER_ROUND)
    hud.showPlay()
    engine.startRound()
  }

  // ---------- camera path (shared PosePipeline) ----------
  function stopCamera(): void {
    unsubscribe?.()
    unsubscribe = null
    // The pipeline is a singleton bound to the first caller's <video>. Stop it only if we started it;
    // if another sport still holds it, leave its camera running.
    if (pipeline && ownsPipeline) pipeline.stop()
    pipeline = null
    ownsPipeline = false
    if (video.srcObject) video.srcObject = null
    tracker = null
    video.classList.remove('ar-live')
  }

  async function startCamera(): Promise<void> {
    if (starting || disposed) return
    starting = true
    stopCamera()
    input.setMouse(false)
    hud.setInputMode('camera')
    hud.showLoading('Starting camera…')
    try {
      const p = await startPosePipeline(video)
      if (disposed || ctx.signal.aborted) {
        p.stop()
        return
      }
      pipeline = p
      ownsPipeline = p.video === video
      if (!ownsPipeline && p.video.srcObject instanceof MediaStream) {
        // Borrowed pipeline: mirror its stream into our preview.
        video.srcObject = p.video.srcObject
        void video.play().catch(() => {})
      }
      video.classList.add('ar-live')
      const calibrator = createCalibrator()
      const aspect = p.videoWidth > 0 && p.videoHeight > 0 ? p.videoWidth / p.videoHeight : 4 / 3
      let calibrated = false
      hud.showCalibration(0, 'no-pose')
      unsubscribe = p.subscribe((frame) => {
        if (disposed) return
        if (tracker) {
          engine.onPoseFrame(tracker.push(frame))
          return
        }
        if (calibrated) return
        const c = calibrator.push(frame, aspect)
        hud.showCalibration(c.progress, c.status)
        if (c.status === 'done' && c.calibration) {
          calibrated = true
          const cal = c.calibration
          later(READY_PAUSE_MS, () => {
            tracker = createBodyTracker(cal, ARCHERY_TRACKER_FILTER)
            begin(cal)
          })
        }
      })
    } catch (err) {
      if (disposed) return
      const kind = err instanceof StartupError ? err.kind : 'camera-other'
      console.warn('[archery] camera failed', err)
      hud.showError(CAMERA_COPY[kind], () => void startCamera(), startMouse)
    } finally {
      starting = false
    }
  }

  // ---------- mouse path ----------
  function startMouse(): void {
    if (disposed) return
    inStartMouse = true
    input.setMouse(true)
    inStartMouse = false
    hud.setInputMode('mouse')
    if (!initialized) begin(null)
    else if (engine.phase === 'idle' || engine.phase === 'ended') startRound()
  }

  hud.showStart(() => void startCamera(), startMouse)

  // ---------- keys ----------
  function onKey(e: KeyboardEvent): void {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
    const t = e.target
    if (t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
    if (e.code === 'Backquote') {
      hud.toggleDebug()
      debugOpen = !debugOpen
    } else if (e.code === 'KeyR' && initialized) {
      startRound()
    } else if (e.code === 'KeyM') {
      muted = !muted
      sfx.setMuted(muted)
      hud.callout(muted ? 'SOUND OFF' : 'SOUND ON', 'info')
    }
  }
  window.addEventListener('keydown', onKey)

  const onPageHide = (): void => engine.flushTelemetry()
  window.addEventListener('pagehide', onPageHide)

  // ---------- frame loop ----------
  let raf = 0
  let last = performance.now()
  let fps = 60
  function frame(now: number): void {
    if (disposed) return
    raf = requestAnimationFrame(frame)
    const dt = Math.min(Math.max(now - last, 0), MAX_DT_MS)
    last = now
    if (dt > 0) fps += (1000 / dt - fps) * 0.05

    if (input.mouseOn) {
      const ptr = input.pointer()
      engine.setMouse({ aim: ptr ? scene.screenToTarget(ptr.x, ptr.y) : { ...TARGET_CENTER }, drawing: input.drawing })
    } else {
      engine.setMouse(null)
    }
    engine.update(dt)
    scene.update(dt * engine.timeScale)
    scene.render()

    if (initialized) {
      const view = engine.view
      hud.setView(view)
      sfx.setDraw(view.phase === 'aiming' && view.drawPhase !== 'idle' ? view.tension : 0)
      const level = view.phase === 'ended' ? 0 : Math.min(1, Math.abs(view.wind) / WIND_FULL)
      if (Math.abs(level - windLevel) > 0.01) {
        windLevel = level
        sfx.setWind(level)
      }
    }

    if (debugOpen) {
      hud.setDebug({
        fps: Math.round(fps),
        input: input.mouseOn ? 'mouse' : tracker ? 'camera' : 'none',
        inferenceMs: pipeline ? Math.round(pipeline.inferenceMs) : '-',
        delegate: pipeline?.delegate ?? '-',
        timeScale: Math.round(engine.timeScale * 100) / 100,
        arrow: engine.arrowIndex,
        ...engine.debug,
      })
    }
  }
  raf = requestAnimationFrame(frame)

  // ---------- dispose ----------
  function dispose(): void {
    if (disposed) return
    disposed = true
    cancelAnimationFrame(raf)
    for (const id of timers) window.clearTimeout(id)
    timers.clear()
    window.removeEventListener('keydown', onKey)
    window.removeEventListener('pagehide', onPageHide)
    ctx.signal.removeEventListener('abort', dispose)
    ro.disconnect()
    stopCamera()
    engine.flushTelemetry()
    input.dispose()
    engine.dispose()
    hud.dispose()
    scene.dispose()
    sfx.dispose()
    root.remove()
  }
  ctx.signal.addEventListener('abort', dispose, { once: true })

  if (opts.debug) {
    hud.toggleDebug()
    debugOpen = true
  }
  if (opts.auto === 'mouse') startMouse()
  else if (opts.auto === 'camera') void startCamera()

  return { dispose }
}
