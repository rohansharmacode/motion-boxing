// @vitest-environment happy-dom
// Shell launcher lifecycle: the REAL mountShell (src/shell) driving the REAL startGoalkeeper
// (src/sports/goalkeeper/index.ts) in happy-dom. Only the WebGL scene and the camera pipeline are
// faked (neither exists in happy-dom); HUD, engine, input, telemetry and both sfx modules are real.
// AudioContext (missing in happy-dom) and ResizeObserver are stubbed to count instances.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { KeeperScene } from '../../src/sports/goalkeeper/types.ts'
import type { PosePipeline } from '../../src/pose/pipeline.ts'
import type { PoseFrame } from '../../src/pose/types.ts'
import type { Shell } from '../../src/shell/types.ts'
import { mountShell } from '../../src/shell/shell.ts'
import { startGoalkeeper } from '../../src/sports/goalkeeper/index.ts'
import { mulberry32 } from '../../src/sports/goalkeeper/striker.ts'
import {
  FakeAudioContext,
  FakeResizeObserver,
  trackListeners,
  trackRaf,
} from './helpers/lifecycle-fakes.ts'
import type { ListenerTracker, RafTracker } from './helpers/lifecycle-fakes.ts'

/** src/shell/shell.ts LAUNCH_MS. */
const LAUNCH_MS = 900

const h = vi.hoisted(() => ({
  scenes: { created: 0, disposed: 0, renders: 0, updates: 0 },
  pipe: {
    mode: 'own' as 'own' | 'borrowed' | 'denied',
    calls: 0,
    subscribes: 0,
    unsubscribes: 0,
    stops: 0,
    lastVideo: null as HTMLVideoElement | null,
    lastCb: null as ((f: PoseFrame | null) => void) | null,
  },
}))

// WebGL is unavailable in happy-dom: a fake KeeperScene with a real <canvas> and counters.
vi.mock('../../src/sports/goalkeeper/scene.ts', () => ({
  createKeeperScene(canvasArg?: HTMLCanvasElement): KeeperScene {
    const canvas = canvasArg ?? document.createElement('canvas')
    // happy-dom has no layout; give the canvas a size so pointer tracking in input.ts works.
    canvas.getBoundingClientRect = () => new DOMRect(0, 0, 1280, 720)
    h.scenes.created++
    let disposed = false
    return {
      canvas,
      resize() {},
      setKeeper() {},
      setBall() {},
      setStriker() {},
      flashSave() {},
      flashGoal() {},
      highlightZone() {},
      shake() {},
      screenToGoal: () => ({ x: 0, y: 1 }),
      reset() {},
      update() {
        h.scenes.updates++
      },
      render() {
        h.scenes.renders++
      },
      dispose() {
        if (disposed) return
        disposed = true
        h.scenes.disposed++
      },
    }
  },
}))

// No camera / MediaPipe in happy-dom: a fake shared pipeline with subscribe/stop counters.
vi.mock('../../src/pose/pipeline.ts', async () => {
  const { StartupError } = await import('../../src/pose/types.ts')
  return {
    async startPosePipeline(video: HTMLVideoElement): Promise<PosePipeline> {
      h.pipe.calls++
      h.pipe.lastVideo = video
      if (h.pipe.mode === 'denied') throw new StartupError('camera-denied', 'fake: permission denied')
      // Borrowed: another sport started the singleton first, bound to its own <video>.
      const pv = h.pipe.mode === 'own' ? video : document.createElement('video')
      return {
        video: pv,
        videoWidth: 640,
        videoHeight: 480,
        delegate: 'CPU',
        inferenceMs: 0,
        subscribe(cb) {
          h.pipe.subscribes++
          h.pipe.lastCb = cb
          return () => {
            h.pipe.unsubscribes++
          }
        },
        stop() {
          h.pipe.stops++
        },
      }
    },
  }
})

let shell: Shell | null = null
let winL: ListenerTracker
let docL: ListenerTracker
let raf: RafTracker
let events: { type: string; summary: boolean }[] = []
const onMotion = (e: Event): void => {
  const d = (e as CustomEvent<{ event_type: string; metrics?: { summary?: unknown } }>).detail
  events.push({ type: d.event_type, summary: d.metrics?.summary === true })
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'],
    now: 0,
  })
  // engine.ts falls back to Math.random (index.ts passes no rng); seed it for deterministic kicks.
  vi.spyOn(Math, 'random').mockImplementation(mulberry32(1234))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  FakeAudioContext.reset()
  FakeResizeObserver.reset()
  Object.assign(h.scenes, { created: 0, disposed: 0, renders: 0, updates: 0 })
  Object.assign(h.pipe, { mode: 'own', calls: 0, subscribes: 0, unsubscribes: 0, stops: 0, lastVideo: null, lastCb: null })
  localStorage.clear()
  events = []
  // Our own event spy goes on before tracking so it is not part of the accounting.
  window.addEventListener('motion-event', onMotion)
  winL = trackListeners(window)
  docL = trackListeners(document)
  raf = trackRaf()
})

afterEach(() => {
  shell?.dispose()
  shell = null
  raf.uninstall()
  docL.uninstall()
  winL.uninstall()
  window.removeEventListener('motion-event', onMotion)
  vi.useRealTimers()
  document.body.replaceChildren()
})

// ---------- helpers ----------

function mount(): Shell {
  shell = mountShell({ launchers: { goalkeeper: (ctx) => startGoalkeeper(ctx) } })
  return shell
}

function host(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.shell-host')
  if (!el) throw new Error('no .shell-host')
  return el
}

function hudView(): string | undefined {
  return document.querySelector<HTMLElement>('.gk-hud')?.dataset.view
}

function btn(scope: string, label: string): HTMLButtonElement {
  const b = [...document.querySelectorAll<HTMLButtonElement>(`${scope} button`)].find((x) => x.textContent?.trim() === label)
  if (!b) throw new Error(`no "${label}" button in ${scope}`)
  return b
}

function key(init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
}

async function launchKeeper(s: Shell): Promise<void> {
  const p = s.launch('goalkeeper')
  await vi.advanceTimersByTimeAsync(LAUNCH_MS + 50)
  await p
}

// ---------- tests ----------

describe('shell + goalkeeper lifecycle', () => {
  test('(a) launch mounts the keeper start view in the shell host; goHome tears it down', async () => {
    const s = mount()
    const p = s.launch('goalkeeper')
    expect(s.current).toBe('goalkeeper')
    await vi.advanceTimersByTimeAsync(LAUNCH_MS - 100)
    expect(document.querySelector('.gk-root')).toBeNull() // still in the launch animation
    await vi.advanceTimersByTimeAsync(150)
    await p

    const root = document.querySelector('.gk-root')
    expect(root).not.toBeNull()
    expect(root?.parentElement).toBe(host())
    expect(document.querySelector<HTMLElement>('.shell')?.dataset.view).toBe('game')
    expect(hudView()).toBe('start')
    expect(h.scenes.created).toBe(1)
    expect(root?.querySelector('canvas')).not.toBeNull()

    s.goHome()
    expect(s.current).toBeNull()
    expect(host().childElementCount).toBe(0)
    expect(document.querySelector('.gk-root')).toBeNull()
    expect(h.scenes.disposed).toBe(1)
    expect(document.querySelector<HTMLElement>('.shell')?.dataset.view).toBe('home')
  })

  test('(b) launch -> mouse game -> goHome 20x leaves no leaks', async () => {
    const s = mount()
    await vi.advanceTimersByTimeAsync(100) // shell's initial focus rAF
    const baseWin = winL.snapshot()
    const baseDoc = docL.snapshot()
    const baseTimers = vi.getTimerCount()
    const baseRaf = raf.live.size
    expect(baseWin).toContain('keydown|false') // shell's own key handler
    expect(baseWin).toContain('motion-event|false') // shell records

    let uiAfterFirst = -1
    let playedKicks = 0
    for (let i = 0; i < 20; i++) {
      await launchKeeper(s)
      expect(document.querySelectorAll('.gk-root')).toHaveLength(1)
      // While a game runs, the keeper's listeners and frame loop are live.
      expect(winL.snapshot().length).toBeGreaterThan(baseWin.length)

      if (i % 2 === 0) btn('.gk-start', 'Play with mouse').click()
      else key({ key: 'd', code: 'KeyD' })
      expect(hudView()).toBe('play')

      const canvas = document.querySelector<HTMLCanvasElement>('.gk-root canvas')
      canvas?.dispatchEvent(new PointerEvent('pointermove', { clientX: 640, clientY: 300, bubbles: true }))

      const rendersBefore = h.scenes.renders
      const evBefore = events.length
      await vi.advanceTimersByTimeAsync(i < 3 ? 6000 : 2000)
      expect(h.scenes.renders - rendersBefore).toBeGreaterThan(50) // the rAF loop really ran
      playedKicks += events.slice(evBefore).filter((e) => e.type === 'SAVE' || e.type === 'GOAL').length

      // A game in play has its frame loop scheduled and HUD callout timers pending.
      expect(raf.live.size).toBeGreaterThan(baseRaf)
      s.goHome()
      expect(s.current).toBeNull()
      expect(document.querySelectorAll('.gk-root')).toHaveLength(0)
      // Checked synchronously: dispose must cancel the pending frame and clear its timers itself,
      // not rely on them firing later into a `disposed` guard.
      expect(raf.live.size).toBe(baseRaf)
      expect(vi.getTimerCount()).toBe(baseTimers)
      if (i === 0) uiAfterFirst = FakeAudioContext.ui().length
    }
    expect(playedKicks).toBeGreaterThan(0) // at least one kick resolved: the engine actually played

    expect(h.scenes.created).toBe(20)
    expect(h.scenes.disposed).toBe(20)

    await vi.advanceTimersByTimeAsync(1000)
    expect(raf.live.size).toBe(baseRaf)
    expect(vi.getTimerCount()).toBe(baseTimers)
    expect(winL.snapshot()).toEqual(baseWin)
    expect(docL.snapshot()).toEqual(baseDoc)

    const keeperCtx = FakeAudioContext.keeper()
    expect(keeperCtx).toHaveLength(20)
    expect(keeperCtx.every((c) => c.state === 'closed')).toBe(true)
    // UI sfx: shell's own context plus the goalkeeper's one shared (module-level) context, never per launch.
    expect(FakeAudioContext.ui().length).toBeLessThanOrEqual(2)
    expect(FakeAudioContext.ui().length).toBe(uiAfterFirst)

    expect(FakeResizeObserver.all).toHaveLength(20)
    expect(FakeResizeObserver.live()).toHaveLength(0)
    expect(FakeResizeObserver.all.every((o) => o.disconnectCalls >= 1)).toBe(true)

    expect(document.querySelectorAll('.gk-root')).toHaveLength(0)
    expect(document.querySelectorAll('canvas')).toHaveLength(0)
    expect(host().childElementCount).toBe(0)

    const evAtEnd = events.length
    const rendersAtEnd = h.scenes.renders
    await vi.advanceTimersByTimeAsync(10_000)
    expect(events.length).toBe(evAtEnd)
    expect(h.scenes.renders).toBe(rendersAtEnd)
  }, 60_000)

  test('(c) the start-screen Home button calls ctx.exit and the shell goes home', async () => {
    const s = mount()
    await launchKeeper(s)
    expect(s.current).toBe('goalkeeper')
    btn('.gk-start', 'Home').click()
    expect(s.current).toBeNull()
    expect(document.querySelector('.gk-root')).toBeNull()
    expect(h.scenes.disposed).toBe(1)
  })

  test('(d) Escape during a game returns home', async () => {
    const s = mount()
    await launchKeeper(s)
    btn('.gk-start', 'Play with mouse').click()
    await vi.advanceTimersByTimeAsync(1000)
    expect(hudView()).toBe('play')
    key({ key: 'Escape', code: 'Escape' })
    expect(s.current).toBeNull()
    expect(document.querySelector('.gk-root')).toBeNull()
    expect(h.scenes.disposed).toBe(1)
    const renders = h.scenes.renders
    await vi.advanceTimersByTimeAsync(500)
    expect(h.scenes.renders).toBe(renders)
  })

  test('(e) startGoalkeeper with an already-aborted signal appends nothing', async () => {
    const el = document.createElement('div')
    document.body.append(el)
    const ctl = new AbortController()
    ctl.abort()
    const before = winL.snapshot()
    const session = await startGoalkeeper({ host: el, signal: ctl.signal, exit: () => {} })
    expect(typeof session.dispose).toBe('function')
    expect(el.childElementCount).toBe(0)
    expect(h.scenes.created).toBe(0)
    expect(FakeResizeObserver.all).toHaveLength(0)
    expect(winL.snapshot()).toEqual(before)
    expect(raf.live.size).toBe(0)
    expect(() => session.dispose()).not.toThrow()
  })

  test('(f) Escape during the launch animation: launcher never runs', async () => {
    const launcher = vi.fn((ctx: Parameters<typeof startGoalkeeper>[0]) => startGoalkeeper(ctx))
    shell = mountShell({ launchers: { goalkeeper: launcher } })
    const s = shell
    const p = s.launch('goalkeeper')
    await vi.advanceTimersByTimeAsync(400)
    key({ key: 'Escape', code: 'Escape' })
    expect(s.current).toBeNull()
    await vi.advanceTimersByTimeAsync(LAUNCH_MS)
    await p
    expect(launcher).not.toHaveBeenCalled()
    expect(h.scenes.created).toBe(0)
    expect(document.querySelector('.gk-root')).toBeNull()

    // The shell is still usable afterwards.
    await launchKeeper(s)
    expect(launcher).toHaveBeenCalledTimes(1)
    expect(document.querySelectorAll('.gk-root')).toHaveLength(1)
  })

  test('(g) camera path, owned pipeline: subscribe on start, unsubscribe + stop on goHome', async () => {
    const s = mount()
    await launchKeeper(s)
    btn('.gk-start', 'Play with camera').click()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.pipe.calls).toBe(1)
    expect(h.pipe.lastVideo).toBe(document.querySelector('.gk-root video.gk-webcam'))
    expect(h.pipe.subscribes).toBe(1)
    expect(hudView()).toBe('calibration')
    h.pipe.lastCb?.(null) // no pose yet: stays on calibration
    expect(hudView()).toBe('calibration')

    s.goHome()
    expect(h.pipe.unsubscribes).toBe(1)
    expect(h.pipe.stops).toBe(1)
    expect(document.querySelector('.gk-root')).toBeNull()
  })

  test('(g) camera path, borrowed pipeline: unsubscribe but do NOT stop', async () => {
    h.pipe.mode = 'borrowed'
    const s = mount()
    await launchKeeper(s)
    btn('.gk-start', 'Play with camera').click()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.pipe.subscribes).toBe(1)
    s.goHome()
    expect(h.pipe.unsubscribes).toBe(1)
    expect(h.pipe.stops).toBe(0)
  })

  test('(h) camera-denied shows the error view with Retry / Play with mouse / Home', async () => {
    h.pipe.mode = 'denied'
    const s = mount()
    await launchKeeper(s)
    btn('.gk-start', 'Play with camera').click()
    await vi.advanceTimersByTimeAsync(0)
    expect(hudView()).toBe('error')
    expect(document.querySelector('.gk-error-msg')?.textContent).toMatch(/Camera access was blocked/)
    const labels = [...document.querySelectorAll('.gk-error button')].map((b) => b.textContent?.trim())
    expect(labels).toEqual(['Retry', 'Play with mouse', 'Home'])
    expect(h.pipe.subscribes).toBe(0)

    btn('.gk-error', 'Retry').click()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.pipe.calls).toBe(2)
    expect(hudView()).toBe('error')

    btn('.gk-error', 'Play with mouse').click()
    expect(hudView()).toBe('play')

    s.goHome()
    expect(h.pipe.stops).toBe(0)
    expect(h.scenes.disposed).toBe(1)
  })

  test('(i) camera calibration -> Ready pause timer; goHome during the pause clears it and the game never begins', async () => {
    const s = mount()
    await vi.advanceTimersByTimeAsync(100)
    const baseTimers = vi.getTimerCount()
    await launchKeeper(s)
    btn('.gk-start', 'Play with camera').click()
    await vi.advanceTimersByTimeAsync(0)
    expect(hudView()).toBe('calibration')
    const cb = h.pipe.lastCb
    if (!cb) throw new Error('pipeline not subscribed')
    for (let t = 0; t <= 2200; t += 33) cb(standingFrame(1000 + t))
    // Calibrated: the Ready pause (index.ts later(READY_PAUSE_MS)) is pending; nothing has begun yet.
    expect(hudView()).toBe('calibration')
    const pending = vi.getTimerCount()
    s.goHome()
    expect(vi.getTimerCount()).toBe(baseTimers)
    expect(pending).toBeGreaterThan(baseTimers)
    await vi.advanceTimersByTimeAsync(2000)
    expect(events.filter((e) => e.type === 'SAVE' || e.type === 'GOAL')).toHaveLength(0)
  })

  test('(i) camera calibration completes -> after the Ready pause the shootout starts (play view)', async () => {
    const s = mount()
    await launchKeeper(s)
    btn('.gk-start', 'Play with camera').click()
    await vi.advanceTimersByTimeAsync(0)
    const cb = h.pipe.lastCb
    if (!cb) throw new Error('pipeline not subscribed')
    for (let t = 0; t <= 2200; t += 33) cb(standingFrame(1000 + t))
    expect(hudView()).toBe('calibration')
    await vi.advanceTimersByTimeAsync(500)
    expect(hudView()).toBe('play')
    s.goHome()
    expect(h.pipe.unsubscribes).toBe(1)
  })

  test('(j) goHome flushes the engine telemetry buffer (buffered TICKs are emitted by dispose)', async () => {
    const s = mount()
    await launchKeeper(s)
    btn('.gk-start', 'Play with mouse').click()
    await vi.advanceTimersByTimeAsync(1000) // < AUTO_FLUSH_MS (2500): TICKs stay buffered
    expect(events.filter((e) => e.type === 'TICK')).toHaveLength(0)
    s.goHome()
    expect(events.filter((e) => e.type === 'TICK').length).toBeGreaterThan(0)
  })

  test('(k) startGoalkeeper standalone: aborting the signal alone disposes everything', async () => {
    const el = document.createElement('div')
    document.body.append(el)
    const ctl = new AbortController()
    const before = winL.snapshot()
    await startGoalkeeper({ host: el, signal: ctl.signal, exit: () => {} })
    expect(el.childElementCount).toBe(1)
    expect(winL.snapshot().length).toBeGreaterThan(before.length)
    ctl.abort() // no dispose() call: the session must listen to the signal itself
    expect(h.scenes.disposed).toBe(1)
    expect(el.childElementCount).toBe(0)
    expect(winL.snapshot()).toEqual(before)
    expect(raf.live.size).toBe(0)
    expect(FakeResizeObserver.live()).toHaveLength(0)
  })

  test('(k) startGoalkeeper standalone: dispose() removes its root from a host the shell does not clear', async () => {
    const el = document.createElement('div')
    const keep = document.createElement('p')
    el.append(keep)
    document.body.append(el)
    const session = await startGoalkeeper({ host: el, signal: new AbortController().signal, exit: () => {} })
    expect(el.querySelector('.gk-root')).not.toBeNull()
    session.dispose()
    expect(el.querySelector('.gk-root')).toBeNull()
    expect([...el.children]).toEqual([keep])
    expect(h.scenes.disposed).toBe(1)
    expect(raf.live.size).toBe(0)
  })

  test('(l) shell goHome disposes a session that ignores the signal, and clears whatever it left in the host', async () => {
    const dispose = vi.fn()
    shell = mountShell({
      launchers: {
        goalkeeper: (ctx) => {
          ctx.host.append(document.createElement('section'))
          return Promise.resolve({ dispose })
        },
      },
    })
    const s = shell
    await launchKeeper(s)
    expect(host().childElementCount).toBe(1)
    s.goHome()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(host().childElementCount).toBe(0)
    s.goHome() // already home: no double dispose
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})

/** A still, front-facing player: both shoulders clearly visible, so the calibrator accepts every frame. */
function standingFrame(t: number): PoseFrame {
  const image = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }))
  const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }))
  image[0] = { x: 0.5, y: 0.3, z: 0, visibility: 1 } // nose
  image[11] = { x: 0.6, y: 0.45, z: 0, visibility: 1 } // L shoulder (mirrored image)
  image[12] = { x: 0.4, y: 0.45, z: 0, visibility: 1 }
  world[11] = { x: 0.18, y: -0.4, z: 0, visibility: 1 }
  world[12] = { x: -0.18, y: -0.4, z: 0, visibility: 1 }
  return { t, image, world }
}
