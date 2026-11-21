// Motion Sports entry: mounts the home dashboard. Each sport loads lazily on launch so the dashboard paints fast.
import './style.css'
import { mountShell } from './shell/index.ts'
import type { GameContext, GameSession } from './shell/index.ts'
import type { BodyTracker } from './pose/body.ts'
import type { Calibrator } from './pose/calibration.ts'
import type { PosePipeline } from './pose/pipeline.ts'
import type { Calibration, PoseFrame, StartupErrorKind } from './pose/types.ts'
import type { BoxingActions, RoundResult } from './sports/boxing/types.ts'

type BoxingState = 'start' | 'loading' | 'calibrating' | 'tutorial' | 'fighting' | 'ended' | 'error'

/** Longest frame step fed to the game, ms (a hidden tab must not jump the round). */
const MAX_DT_MS = 50
const DEBUG_INTERVAL_MS = 100
const NOOP_SESSION: GameSession = { dispose() {} }

function el<T extends HTMLElement>(selector: string, type: new () => T): T {
  const node = document.querySelector(selector)
  if (!(node instanceof type)) throw new Error(`Kinetic Ring: missing ${selector} in index.html`)
  return node
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select') !== null)
}

async function startBoxing(ctx: GameContext): Promise<GameSession> {
  const [
    { createBoxingScene },
    { createBoxingHud },
    { createKineticHud },
    { createTelemetry },
    { BOXING_FILTER, createBoxingDetector },
    { createBoxingEngine },
    { createKeyboardFallback },
    { createBoxingSfx },
    { buildLocalCoachCard },
    { createDemoRound, emitDemoTelemetry },
    { createBodyTracker },
    { createCalibrator, defaultCalibration },
    { createPoseOverlay },
    { onPipelineEnded, startPosePipeline },
    { StartupError },
    { createBoxingTutorial, tutorialNeeded },
    { createTrackingHint },
    { createQualityGovernor },
  ] = await Promise.all([
    import('./sports/boxing/scene.ts'),
    import('./sports/boxing/hud.ts'),
    import('./ui/KineticHud.ts'),
    import('./sports/boxing/telemetry.ts'),
    import('./sports/boxing/detector.ts'),
    import('./sports/boxing/engine.ts'),
    import('./sports/boxing/keyboard.ts'),
    import('./sports/boxing/sfx.ts'),
    import('./sports/boxing/coach.ts'),
    import('./sports/boxing/demo.ts'),
    import('./pose/body.ts'),
    import('./pose/calibration.ts'),
    import('./pose/overlay.ts'),
    import('./pose/pipeline.ts'),
    import('./pose/types.ts'),
    import('./sports/boxing/tutorial.ts'),
    import('./pose/trackingHint.ts'),
    import('./pose/qualityGovernor.ts'),
  ])
  // Nothing has been created yet, so there is nothing to dispose.
  if (ctx.signal.aborted) return NOOP_SESSION

  const app = el('#app', HTMLElement)
  const video = el('#webcam', HTMLVideoElement)
  const overlayCanvas = el('#overlay', HTMLCanvasElement)
  const ui = el('#ui', HTMLDivElement)

  const arena = document.createElement('div')
  arena.id = 'arena'
  app.prepend(arena)
  let scene: ReturnType<typeof createBoxingScene>
  try {
    scene = createBoxingScene(arena)
  } catch (err) {
    arena.remove()
    throw err
  }
  // Kinetic HUD: live stats, then the post-match screen with the Cortex coach card and leaderboard.
  // It also bridges this round's motion events to the server (src/api/boxingLink.ts, mock mode
  // without VITE_API_URL). ?hud=classic keeps the original in-game HUD.
  const hud = new URLSearchParams(location.search).get('hud') === 'classic' ? createBoxingHud(ui) : createKineticHud(ui, { ctx })
  const telemetry = createTelemetry()
  const overlay = createPoseOverlay(overlayCanvas)
  const trackingHint = createTrackingHint(ui)
  const governor = createQualityGovernor()
  // Every punch the camera reads bursts on that fist in the preview, so players see what registered.
  const flashPunches = (a: BoxingActions): BoxingActions => {
    for (const p of a.punches) overlay.flash(p.hand, p.kind.toUpperCase())
    return a
  }
  const rawDetector = createBoxingDetector()
  const detector: typeof rawDetector = {
    update: (b) => flashPunches(rawDetector.update(b)),
    reset: () => rawDetector.reset(),
  }
  const sfx = createBoxingSfx()
  const engine = createBoxingEngine({ hud, telemetry, detector, sfx, getPlayerName: () => hud.playerName })
  const keyboard = createKeyboardFallback()
  // Bind the scene now so the drone idles on the start screen; beginFight rebinds with the real calibration.
  engine.init(scene, defaultCalibration(16 / 9))

  let state: BoxingState = 'start'
  let disposed = false
  let pipeline: PosePipeline | null = null
  let stopFrames: (() => void) | null = null
  /** Bumped whenever the camera is stopped, so a pending start knows it is stale. */
  let cameraToken = 0
  let calibrator: Calibrator | null = null
  let tutorial: ReturnType<typeof createBoxingTutorial> | null = null
  /** Separate detector for practice so its cooldowns and baselines never leak into the round. */
  const tutorialDetector = createBoxingDetector()
  let bodyTracker: BodyTracker | null = null
  let calibration: Calibration = defaultCalibration(16 / 9)
  let aspect = 16 / 9
  let frames = 0
  let eventCount = 0
  let punchCount = 0
  let raf = 0

  function setState(next: BoxingState): void {
    state = next
    document.body.dataset.state = next
    overlay.setGuide(next === 'calibrating')
    trackingHint.setActive((next === 'fighting' || next === 'tutorial') && pipeline !== null)
    if (next !== 'tutorial') endTutorial()
  }

  function endTutorial(): void {
    const t = tutorial
    tutorial = null
    t?.dispose()
  }

  function beginTutorial(c: Calibration): void {
    calibration = c
    tutorialDetector.reset()
    setState('tutorial')
    tutorial = createBoxingTutorial(ui, {
      onStep: () => sfx.block(),
      onDone: () => {
        if (state === 'tutorial') beginFight(calibration)
      },
    })
  }

  function stopCamera(): void {
    cameraToken++
    stopFrames?.()
    stopFrames = null
    pipeline?.stop()
    pipeline = null
    calibrator = null
    bodyTracker = null
    trackingHint.setActive(false)
    overlay.draw(null, false)
  }

  function showStart(): void {
    setState('start')
    hud.showStart(() => void startCamera(), startKeyboard)
  }

  function showError(kind: StartupErrorKind): void {
    setState('error')
    hud.showError(kind, () => void startCamera(), startKeyboard)
  }

  function beginCalibration(): void {
    calibrator = createCalibrator()
    bodyTracker = null
    setState('calibrating')
    hud.showCalibration(0, 'no-pose')
  }

  function beginFight(c: Calibration): void {
    calibration = c
    engine.init(scene, c)
    engine.startRound()
    hud.setCameraActive(pipeline !== null)
    hud.showFight()
    setState('fighting')
  }

  function again(): void {
    if (bodyTracker || keyboard.enabled) beginFight(calibration)
    else if (pipeline) beginCalibration()
    else showStart()
  }

  /** Round-end coach. A remote coach can replace the local card here later. */
  function showCoach(result: RoundResult): void {
    hud.setCoachCard(null)
    hud.setCoachCard(buildLocalCoachCard(result, engine.getRoundLog()))
  }

  engine.onRoundEnd((result) => {
    setState('ended')
    hud.showRoundEnd(result, again, () => ctx.exit())
    showCoach(result)
  })

  function startDemo(): void {
    // A camera still loading would pull the game back into calibration when it arrives.
    if (state === 'loading') stopCamera()
    engine.abortRound()
    const demo = createDemoRound()
    emitDemoTelemetry(telemetry, demo, hud.playerName)
    hud.showRoundEnd(demo.result, again, () => ctx.exit())
    hud.setCoachCard(demo.card)
    setState('ended')
  }

  function onFrame(frame: PoseFrame | null): void {
    frames++
    overlay.draw(frame, state === 'fighting' && engine.debug.guard === 1)
    trackingHint.push(frame)
    if (state === 'calibrating' && calibrator) {
      const p = calibrator.push(frame, aspect)
      hud.showCalibration(p.progress, p.status)
      if (p.status === 'done' && p.calibration) {
        calibrator = null
        bodyTracker = createBodyTracker(p.calibration, BOXING_FILTER)
        if (tutorialNeeded()) beginTutorial(p.calibration)
        else beginFight(p.calibration)
      }
    } else if (state === 'tutorial' && bodyTracker && tutorial) {
      const body = bodyTracker.push(frame)
      const actions = flashPunches(tutorialDetector.update(body))
      tutorial.onActions(actions, body ? body.t : performance.now())
    } else if ((state === 'fighting' || state === 'ended') && bodyTracker) {
      engine.onPoseFrame(bodyTracker.push(frame))
    }
  }

  async function startCamera(): Promise<void> {
    if (disposed || pipeline || state === 'loading') return
    const token = ++cameraToken
    setState('loading')
    hud.setCameraActive(true)
    hud.showLoading('Starting camera and pose tracker')
    try {
      const p = await startPosePipeline(video)
      if (disposed || ctx.signal.aborted || token !== cameraToken) {
        p.stop()
        return
      }
      pipeline = p
      overlay.resize(p.videoWidth, p.videoHeight)
      document.body.dataset.delegate = p.delegate
      document.body.dataset.poseMode = p.mode
      aspect = p.videoWidth / p.videoHeight
      stopFrames = p.subscribe(onFrame)
      beginCalibration()
    } catch (err) {
      if (disposed || ctx.signal.aborted || token !== cameraToken) return
      console.error('Kinetic Ring: startup failed', err)
      showError(err instanceof StartupError ? err.kind : 'tracker-failed')
    }
  }

  // The camera died on its own (unplugged, track ended): never leave the player stuck.
  const stopEnded = onPipelineEnded((reason) => {
    if (!pipeline) return
    console.warn('Kinetic Ring: camera ended', reason)
    stopCamera()
    hud.setCameraActive(false)
    if (state === 'ended') return
    if (state === 'fighting' && keyboard.enabled) {
      engine.onPoseFrame(null)
      return
    }
    engine.abortRound()
    showError('camera-other')
  })

  function startKeyboard(): void {
    stopCamera()
    keyboard.setEnabled(true)
    hud.setKeyboardMode(true)
    hud.setCameraActive(false)
    beginFight(defaultCalibration(16 / 9))
  }

  // ---------- page listeners (all removed in dispose) ----------
  const unlockAudio = (): void => sfx.unlock()

  function onKeyDown(e: KeyboardEvent): void {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return
    if (e.code === 'KeyD') {
      if (state === 'fighting' || state === 'ended') hud.setKeyboardMode(keyboard.toggle())
      else startKeyboard()
    } else if (e.code === 'Backquote') {
      hud.toggleDebug()
    } else if (e.code === 'KeyR' && state === 'ended') {
      again()
    } else if (e.code === 'KeyM') {
      startDemo()
    }
  }

  function onMotionEvent(e: Event): void {
    eventCount++
    const detail: unknown = e instanceof CustomEvent ? e.detail : null
    if (typeof detail === 'object' && detail !== null && 'event_type' in detail && detail.event_type === 'PUNCH') {
      punchCount++
    }
    document.body.dataset.events = String(eventCount)
    document.body.dataset.punches = String(punchCount)
  }

  function onResize(): void {
    scene.resize(innerWidth, innerHeight)
  }

  window.addEventListener('pointerdown', unlockAudio, true)
  window.addEventListener('keydown', unlockAudio, true)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('motion-event', onMotionEvent)
  window.addEventListener('resize', onResize)
  onResize()

  // ---------- one animation loop per session ----------
  let last = performance.now()
  let fps = 0
  let statAcc = 0
  let statFrames = 0
  let debugAcc = 0
  function loop(now: number): void {
    if (disposed) return
    raf = requestAnimationFrame(loop)
    const rawDt = Math.max(now - last, 0)
    const dt = Math.min(rawDt, MAX_DT_MS)
    last = now
    // Automatic quality: low under ~50 fps or when tracking is slow, back to high after fast frames.
    const nextQuality = governor.update(rawDt, pipeline ? pipeline.inferenceMs : 0)
    if (nextQuality) scene.setQuality(nextQuality)
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
    debugAcc += dt
    if (debugAcc >= DEBUG_INTERVAL_MS) {
      debugAcc = 0
      hud.setDebug({
        ...engine.debug,
        fps,
        inferenceMs: pipeline ? Math.round(pipeline.inferenceMs * 10) / 10 : 0,
        delegate: pipeline ? pipeline.delegate : 'none',
        quality: scene.quality,
      })
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    cancelAnimationFrame(raf)
    stopCamera()
    stopEnded()
    window.removeEventListener('pointerdown', unlockAudio, true)
    window.removeEventListener('keydown', unlockAudio, true)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('motion-event', onMotionEvent)
    window.removeEventListener('resize', onResize)
    keyboard.dispose()
    engine.dispose()
    scene.dispose()
    sfx.dispose()
    endTutorial()
    trackingHint.dispose()
    hud.dispose()
    arena.remove()
    overlay.draw(null, false)
    document.body.dataset.state = 'home'
  }
  ctx.signal.addEventListener('abort', dispose, { once: true })

  document.body.dataset.events = '0'
  document.body.dataset.punches = '0'
  document.body.dataset.frames = '0'
  showStart()
  raf = requestAnimationFrame(loop)
  return { dispose }
}

const goalkeeper = (ctx: GameContext): Promise<GameSession> =>
  import('./sports/goalkeeper/index.ts').then((m) => m.startGoalkeeper(ctx))

const leaderboard = (ctx: GameContext): Promise<GameSession> =>
  import('./ui/LeaderboardScreen.ts').then((m) => m.startLeaderboard(ctx))

mountShell({ launchers: { boxing: startBoxing, goalkeeper, leaderboard } })

// Warm the pose tracker download once the dashboard is idle; the camera only starts on the player's choice.
if (!document.head.querySelector('link[rel="preconnect"][href="https://cdn.jsdelivr.net"]')) {
  const link = document.createElement('link')
  link.rel = 'preconnect'
  link.href = 'https://cdn.jsdelivr.net'
  link.crossOrigin = ''
  document.head.append(link)
}
const prefetch = (): void => {
  import('./pose/pipeline.ts').then((m) => m.prefetchPoseAssets()).catch(() => {})
}
if (typeof requestIdleCallback === 'function') requestIdleCallback(prefetch, { timeout: 3000 })
else setTimeout(prefetch, 1500)
