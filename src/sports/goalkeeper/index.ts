// Reflex Keeper entry for the shell: startGoalkeeper(ctx) builds the game inside ctx.host and returns a
// GameSession. Camera path uses the shared PosePipeline + calibrator + body tracker from src/pose;
// mouse path (D toggles any time) needs no camera. Research doc section 3 (Sport 2) and 4.
import { startPosePipeline } from '../../pose/pipeline.ts'
import type { PosePipeline } from '../../pose/pipeline.ts'
import { createCalibrator } from '../../pose/calibration.ts'
import { createBodyTracker } from '../../pose/body.ts'
import { createTrackingHint } from '../../pose/trackingHint.ts'
import { createQualityGovernor } from '../../pose/qualityGovernor.ts'
import type { BodyTracker } from '../../pose/body.ts'
import { StartupError } from '../../pose/types.ts'
import type { StartupErrorKind } from '../../pose/types.ts'
import type { GameContext, GameSession } from '../../shell/types.ts'
import { createSfx } from '../../shell/sfx.ts'
import type { Sfx } from '../../shell/sfx.ts'
import { createKeeperScene } from './scene.ts'
import { createKeeperEngine } from './engine.ts'
import { createKeeperTelemetry } from './telemetry.ts'
import { createKeeperHud } from './hud.ts'
import { createKeeperInput } from './input.ts'
import { createKeeperSfx } from './sfx.ts'
import { KICKS_PER_SHOOTOUT } from './types.ts'
import { loadDifficulty, saveDifficulty } from './difficulty.ts'
import { PRACTICE_KICKS } from './shots.ts'
import { COUNTDOWN_LABELS, COUNTDOWN_MS, COUNTDOWN_STEP_MS, dailyKey, loadDailyBest, plannedKicks, saveDailyBest } from './modes.ts'
import type { RoundMode } from './modes.ts'
import type { Calibration, KickResult } from './types.ts'

/** Goalkeeper 1-euro tuning from the doc (minimal lag for reflex lunges). body.ts filters in pixels. */
const KEEPER_FILTER = { minCutoff: 1.2, beta: 0.12, dCutoff: 1.0 }
/** Pause on the "Ready!" calibration screen before the first kick, ms. */
const READY_PAUSE_MS = 450

const CAMERA_COPY: Record<StartupErrorKind, string> = {
  'camera-denied': 'Camera access was blocked. Allow it in the address bar, then retry.',
  'camera-not-found': 'No camera found. Plug one in and retry.',
  'camera-in-use': 'The camera is busy in another app or tab. Close it and retry.',
  'camera-unsupported': 'This browser cannot use the camera here (it needs https or localhost).',
  'camera-other': 'The camera could not start.',
  'tracker-failed': 'The pose tracker failed to load. Check your connection and retry.',
}

let uiSfx: Sfx | null = null

export interface GoalkeeperOptions {
  /** Skip the start screen: 'mouse' or 'camera'. */
  auto?: 'mouse' | 'camera'
  /** Open the debug panel. */
  debug?: boolean
  /** Running inside the shell, which draws its own Home pill. Default true; goalkeeper.html passes false. */
  embedded?: boolean
}

export async function startGoalkeeper(ctx: GameContext, opts: GoalkeeperOptions = {}): Promise<GameSession> {
  if (ctx.signal.aborted) return { dispose() {} }

  // ---------- DOM ----------
  const root = document.createElement('div')
  const embedded = opts.embedded !== false
  root.className = embedded ? 'gk-root gk-page gk-embedded' : 'gk-root gk-page'
  const stage = document.createElement('div')
  stage.className = 'gk-stage'
  const video = document.createElement('video')
  video.className = 'gk-webcam'
  video.playsInline = true
  video.muted = true
  const ui = document.createElement('div')
  ui.className = 'gk-ui'
  root.append(stage, ui)
  ctx.host.append(root)
  const trackingHint = createTrackingHint(ui)
  const governor = createQualityGovernor()

  uiSfx ??= createSfx() // shell sfx has no dispose: share one AudioContext across launches
  const sfx = createKeeperSfx()
  const scene = createKeeperScene()
  stage.append(scene.canvas, video)
  const hud = createKeeperHud(ui, {
    cornerHome: !embedded,
    onHome: () => {
      uiSfx?.back()
      ctx.exit()
    },
    onButton: () => {
      uiSfx?.select()
      sfx.startCrowd()
    },
  })
  const telemetry = createKeeperTelemetry()
  const engine = createKeeperEngine({ telemetry })
  engine.setDifficulty(loadDifficulty())
  hud.setDifficulty(engine.difficulty, (level) => {
    engine.setDifficulty(level)
    saveDifficulty(level)
  })

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
  const timers = new Set<number>()

  const later = (ms: number, fn: () => void): void => {
    const id = window.setTimeout(() => {
      timers.delete(id)
      if (!disposed) fn()
    }, ms)
    timers.add(id)
  }

  const input = createKeeperInput({
    canvas: scene.canvas,
    screenToGoal: (x, y) => scene.screenToGoal(x, y),
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
  function resultCallout(r: KickResult): void {
    if (r.outcome === 'save' && r.part === null) hud.callout('WIDE!', 'info')
    else if (r.grade) hud.gradePopup(r.grade, r.combo ?? 0, r.points ?? 0)
    else hud.callout(r.outcome === 'goal' ? 'GOAL' : 'SAVED!', r.outcome === 'goal' ? 'bad' : 'good')
  }

  // ---------- guided practice (opt-in from the start screen or P, skippable with S) ----------
  let practiceWanted = false
  hud.setPracticeChoice(false, (on) => {
    practiceWanted = on
  })
  const markPracticeDone = (): void => {
    practiceWanted = false
    hud.setPracticeChoice(false, (on) => {
      practiceWanted = on
    })
  }
  const PRACTICE_IDLE: readonly string[] = [
    'Watch the arrow on the grass when the striker winds up.',
    'Same again: follow the arrow with your hands.',
    'A pink, longer arrow means a high shot. Hands up!',
  ]
  function practicePrompt(phase: string, kick: number): string | null {
    if (phase === 'idle') return PRACTICE_IDLE[kick] ?? null
    if (phase === 'telegraph') return 'Now! Move your hands to where it points.'
    return null
  }
  function skipPractice(): void {
    if (!engine.practice) return
    markPracticeDone()
    hud.setPractice(null)
    startShootout()
  }
  // ---------- round mode (classic / sudden death / daily) ----------
  const MODE_KEY = 'gk.mode'
  let roundMode: RoundMode = (() => {
    try {
      const v = localStorage.getItem(MODE_KEY)
      return v === 'sudden' || v === 'daily' ? v : 'classic'
    } catch {
      return 'classic'
    }
  })()
  const refreshModeChoice = (): void =>
    hud.setModeChoice(
      roundMode,
      (m) => {
        roundMode = m
        try {
          localStorage.setItem(MODE_KEY, m)
        } catch {
          /* storage blocked */
        }
      },
      loadDailyBest(dailyKey(new Date())),
    )
  refreshModeChoice()

  const kicksNow = (): number => {
    if (engine.practice) return PRACTICE_KICKS
    return plannedKicks(engine.mode) ?? engine.results.length + 1
  }

  engine.onKickResult((r) => {
    hud.setTelegraph(false)
    if (r.outcome === 'goal') hud.flash('goal')
    else if (r.part !== null) hud.flash('save')
    hud.setScoreboard(engine.results, kicksNow())
    if (engine.practice) {
      hud.setPractice(r.outcome === 'goal' ? 'Close! Reach a little further next time.' : 'Nice save! That is all there is to it.')
    }
    resultCallout(r)
    sfx.setTension(0)
    if (r.outcome === 'goal') {
      sfx.net()
      sfx.groan()
    } else {
      if (r.part !== null) sfx.save(r.punch)
      if (r.grade && r.grade !== 'miss') sfx.grade(r.grade, r.combo ?? 1)
      sfx.roar(r.grade === 'perfect' ? 1.4 : engine.mode === 'sudden' ? 1.2 : 1)
    }
  })

  engine.onStrikerPhase((phase, kick) => {
    switch (phase) {
      case 'idle':
        hud.setScoreboard(engine.results, kicksNow())
        if (engine.practice) hud.setPractice(practicePrompt('idle', kick))
        else if (kick === 0) break // the kickoff countdown covers kick 1
        else if (engine.mode === 'sudden') hud.callout('SUDDEN DEATH', 'bad')
        else if (engine.mode === 'daily') hud.callout(`SHOT ${kick + 1}/${kicksNow()}`, 'info')
        else hud.callout(kick === KICKS_PER_SHOOTOUT - 1 ? 'LAST KICK' : `KICK ${kick + 1}`, 'info')
        sfx.setTension(0.25)
        break
      case 'runup':
        sfx.whistle()
        sfx.setTension(0.6)
        break
      case 'telegraph':
        hud.setTelegraph(true)
        if (engine.practice) hud.setPractice(practicePrompt('telegraph', kick))
        sfx.setTension(1)
        break
      case 'kick':
        hud.setTelegraph(false)
        sfx.kick(1)
        break
      case 'recover':
        break
    }
  })

  engine.onShootoutEnd((result) => {
    hud.setTelegraph(false)
    if (result.practice) {
      markPracticeDone()
      hud.setPractice('Practice done. Here comes the real shootout!')
      later(1600, () => {
        hud.setPractice(null)
        startShootout()
      })
      return
    }
    sfx.setTension(0)
    const good = result.mode === 'sudden' ? result.saves >= 3 : result.saves > result.goals
    sfx.fullTime(good)
    trackingHint.setActive(false)
    let extra: { dailyBest: number | null; newBest: boolean } | undefined
    if (result.mode === 'daily' && result.dailyKey) {
      const newBest = saveDailyBest(result.dailyKey, result.score)
      extra = { dailyBest: loadDailyBest(result.dailyKey), newBest }
      refreshModeChoice()
    }
    hud.showEnd(result, () => startShootout(), extra)
  })

  function begin(calibration: Calibration | null): void {
    if (disposed) return
    engine.init(scene, calibration)
    initialized = true
    startShootout(practiceWanted)
  }

  const countdownTimers: number[] = []
  function cancelCountdown(): void {
    for (const id of countdownTimers) {
      window.clearTimeout(id)
      timers.delete(id)
    }
    countdownTimers.length = 0
    hud.countdown(null)
  }
  function runCountdown(): void {
    cancelCountdown()
    COUNTDOWN_LABELS.forEach((label, i) => {
      const id = window.setTimeout(() => {
        timers.delete(id)
        if (disposed) return
        hud.countdown(label)
        sfx.countdown(i, i === COUNTDOWN_LABELS.length - 1)
      }, i * COUNTDOWN_STEP_MS)
      timers.add(id)
      countdownTimers.push(id)
    })
    const done = window.setTimeout(() => {
      timers.delete(done)
      if (!disposed) hud.countdown(null)
    }, COUNTDOWN_MS)
    timers.add(done)
    countdownTimers.push(done)
  }

  function startShootout(practice = false): void {
    const mode: RoundMode = practice ? 'practice' : roundMode
    sfx.startCrowd()
    hud.setRoundMode(mode)
    hud.setScoreboard([], practice ? PRACTICE_KICKS : (plannedKicks(mode) ?? 1))
    hud.setPractice(practice ? 'Practice: 3 slow shots to learn the arrow.' : null, skipPractice)
    hud.showPlay()
    trackingHint.setActive(tracker !== null && !input.mouseOn)
    if (practice) cancelCountdown()
    else runCountdown()
    // The engine runs at once (so telemetry ticks flow) but holds the first kick until the countdown ends.
    engine.startShootout({ mode, countdownMs: practice ? 0 : COUNTDOWN_MS })
  }

  // ---------- camera path (shared PosePipeline) ----------
  function stopCamera(): void {
    trackingHint.setActive(false)
    unsubscribe?.()
    unsubscribe = null
    // The pipeline is a singleton bound to the first caller's <video>. Stop it only if we started it;
    // if another sport still holds it, leave its camera running.
    if (pipeline && ownsPipeline) pipeline.stop()
    pipeline = null
    ownsPipeline = false
    if (video.srcObject) video.srcObject = null
    tracker = null
    video.classList.remove('gk-live')
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
      video.classList.add('gk-live')
      const calibrator = createCalibrator()
      const aspect = p.videoWidth > 0 && p.videoHeight > 0 ? p.videoWidth / p.videoHeight : 4 / 3
      let calibrated = false
      hud.showCalibration(0, 'no-pose')
      unsubscribe = p.subscribe((frame) => {
        if (disposed) return
        if (tracker) {
          trackingHint.push(frame)
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
            tracker = createBodyTracker(cal, KEEPER_FILTER)
            begin(cal)
          })
        }
      })
    } catch (err) {
      if (disposed) return
      const kind = err instanceof StartupError ? err.kind : 'camera-other'
      console.warn('[goalkeeper] camera failed', err)
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
    if (!tracker) begin(null)
    else startShootout(practiceWanted)
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
    } else if (e.code === 'KeyS' && engine.practice) {
      skipPractice()
    } else if (e.code === 'KeyP' && initialized && !engine.practice) {
      startShootout(true)
    } else if (e.code === 'KeyR' && initialized) {
      startShootout()
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
    const rawDt = Math.max(now - last, 0)
    const dt = Math.min(rawDt, 250)
    last = now
    const nextQuality = governor.update(rawDt, pipeline ? pipeline.inferenceMs : 0)
    if (nextQuality) scene.setQuality(nextQuality)
    if (dt > 0) fps += (1000 / dt - fps) * 0.05

    input.update(dt)
    engine.setPointer(input.mouseOn ? input.target() : null)
    engine.update(dt)
    scene.update(dt * engine.timeScale)
    scene.render()

    if (debugOpen) {
      hud.setDebug({
        fps: Math.round(fps),
        input: input.mouseOn ? 'mouse' : tracker ? 'camera' : 'none',
        inferenceMs: pipeline ? Math.round(pipeline.inferenceMs) : '-',
        delegate: pipeline?.delegate ?? '-',
        timeScale: engine.timeScale,
        kickIndex: engine.kickIndex,
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
    trackingHint.dispose()
    ctx.signal.removeEventListener('abort', dispose)
    ro.disconnect()
    stopCamera()
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
