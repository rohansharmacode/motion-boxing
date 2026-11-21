// Lifecycle tests against the real shell + goalkeeper with real WebGL (swiftshader):
//  - 20x launch -> Escape (dispose) then one more launch: every WebGL context of a disposed game is
//    released, window listeners / ResizeObservers / the rAF loop return to the dashboard baseline, no
//    DOM/heap leaks, no motion-events after the game is gone.
//  - camera path (?auto=camera) with a deterministic canvas-backed camera: reaches calibration, Escape
//    makes the app stop() every MediaStreamTrack it was handed, and a second camera launch works.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const BROWSER_ARGS = [
  '--enable-unsafe-swiftshader',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
]

// test.use replaces the config's launchOptions, so repeat its flags and add --expose-gc.
test.use({ launchOptions: { args: [...BROWSER_ARGS, '--js-flags=--expose-gc'] } })

/** Leak probes installed before any page script runs (see installProbes). */
interface Probes {
  /** Live window listeners of the watched types, `${type}|${capture}` -> count. */
  windowListeners: () => Record<string, number>
  /** Every WebGL context handed out by getContext, in creation order. */
  glContexts: (WebGLRenderingContext | WebGL2RenderingContext)[]
  /** ResizeObservers that observed something and were not disconnected. */
  liveObservers: () => number
  /** requestAnimationFrame calls so far. */
  rafCalls: number
}

interface HarnessWindow {
  __shell: { current: string | null }
  __events: unknown[]
  __probes: Probes
  gc?: () => void
  __tracks?: MediaStreamTrack[]
  /** Tracks the app called stop() on. */
  __stopped?: MediaStreamTrack[]
  __gumCalls?: number
}

// The shell has two dashboard layouts behind a flag in src/shell/shell.ts (`channels`): the hero tile
// grid (.shell-tile, click launches) and the channel grid (.ch-tile, click opens a preview whose Start
// launches). These helpers work with whichever one is live.
const GK_TILE = '.shell-tile[data-id=goalkeeper], .ch-tile[data-id=goalkeeper]'

async function isChannels(page: Page): Promise<boolean> {
  return page.locator('.shell').evaluate((el) => el.classList.contains('shell--channels'))
}

/** Clicks the goalkeeper tile (and the preview's Start on the channel grid). */
async function openGoalkeeper(page: Page): Promise<void> {
  await page.locator(GK_TILE).click()
  if (await isChannels(page)) {
    await expect(page.locator('.ch-preview')).toHaveAttribute('data-id', 'goalkeeper')
    await page.locator('.ch-btn--start').click()
  }
}

async function launchAndWaitForPlay(page: Page): Promise<void> {
  await openGoalkeeper(page)
  await expect(page.locator('.gk-hud')).toHaveAttribute('data-view', 'play', { timeout: 15_000 })
  await expect(page.locator('.shell')).toHaveAttribute('data-view', 'game')
}

async function escapeHome(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.locator('.shell')).toHaveAttribute('data-view', 'home')
  await expect(page.locator('.gk-root')).toHaveCount(0)
}

async function heapAfterGc(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as HarnessWindow
    w.gc?.()
    w.gc?.()
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    return mem ? mem.usedJSHeapSize : -1
  })
}

/** Wraps window add/removeEventListener, getContext, ResizeObserver and requestAnimationFrame. */
async function installProbes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Window listener types the game registers (input.ts, index.ts). Pointer types are left out: Playwright's
    // click hit-target check adds its own capture-phase pointer listeners on window.
    const WATCHED = new Set(['keydown', 'keyup', 'blur', 'pagehide', 'resize'])
    const live = new Map<string, Set<unknown>>()
    const key = (type: string, opts?: boolean | EventListenerOptions): string =>
      `${type}|${typeof opts === 'boolean' ? opts : !!opts?.capture}`
    const origAdd = window.addEventListener.bind(window)
    const origRemove = window.removeEventListener.bind(window)
    window.addEventListener = ((
      type: string,
      fn: EventListenerOrEventListenerObject | null,
      opts?: boolean | AddEventListenerOptions,
    ) => {
      if (fn && WATCHED.has(type) && !(typeof opts === 'object' && opts.once)) {
        const k = key(type, opts)
        if (!live.has(k)) live.set(k, new Set())
        live.get(k)?.add(fn)
      }
      origAdd(type, fn, opts)
    }) as typeof window.addEventListener
    window.removeEventListener = ((
      type: string,
      fn: EventListenerOrEventListenerObject | null,
      opts?: boolean | EventListenerOptions,
    ) => {
      if (fn) live.get(key(type, opts))?.delete(fn)
      origRemove(type, fn, opts)
    }) as typeof window.removeEventListener

    const glContexts: (WebGLRenderingContext | WebGL2RenderingContext)[] = []
    const origGetContext = HTMLCanvasElement.prototype.getContext as (...a: unknown[]) => RenderingContext | null
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, id: string, ...rest: unknown[]) {
      const c = origGetContext.call(this, id, ...rest)
      if (c && (id === 'webgl' || id === 'webgl2') && !glContexts.includes(c as WebGLRenderingContext)) {
        glContexts.push(c as WebGLRenderingContext)
      }
      return c
    } as typeof HTMLCanvasElement.prototype.getContext

    const observing = new Set<ResizeObserver>()
    const OrigRO = window.ResizeObserver
    window.ResizeObserver = class extends OrigRO {
      observe(t: Element, o?: ResizeObserverOptions): void {
        observing.add(this)
        super.observe(t, o)
      }
      disconnect(): void {
        observing.delete(this)
        super.disconnect()
      }
    }

    const probes: Probes = {
      windowListeners: () => Object.fromEntries([...live].filter(([, s]) => s.size > 0).map(([k, s]) => [k, s.size])),
      glContexts,
      liveObservers: () => observing.size,
      rafCalls: 0,
    }
    const origRaf = window.requestAnimationFrame.bind(window)
    window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      probes.rafCalls++
      return origRaf(cb)
    }
    ;(window as unknown as HarnessWindow).__probes = probes
  })
}

interface ProbeSnapshot {
  listeners: Record<string, number>
  observers: number
  contexts: number
  lost: boolean[]
  raf: number
}

const snapshot = (page: Page): Promise<ProbeSnapshot> =>
  page.evaluate(() => {
    const p = (window as unknown as HarnessWindow).__probes
    return {
      listeners: p.windowListeners(),
      observers: p.liveObservers(),
      contexts: p.glContexts.length,
      lost: p.glContexts.map((c) => c.isContextLost()),
      raf: p.rafCalls,
    }
  })

// Declared (so run) before the 20x test, in its own fresh Edge process: after the 20x real-WebGL test,
// swiftshader sometimes starves MediaPipe's landmarker setup (the 5.7 MB pose_landmarker_lite.task fetch
// took > 20 s). Seen only in that order, never in isolation.
test('camera: ?auto=camera reaches calibration, Escape stops every track, a second camera launch works', async ({
  playwright,
  baseURL,
}) => {
  test.setTimeout(120_000)
  const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true, args: BROWSER_ARGS })
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 } })
  const page = await context.newPage()
  try {
    await cameraFlow(page)
  } finally {
    await browser.close()
  }
})

test('20x launch → dispose with real WebGL, no leaks', async ({ page }) => {
  test.setTimeout(240_000)
  const consoleLines: string[] = []
  const pageErrors: string[] = []
  page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`))
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await installProbes(page)

  await page.goto('/tests/gk-shell.html?auto=mouse')
  await expect(page.locator(GK_TILE)).toHaveAttribute('data-ready', 'true')
  expect(await page.evaluate(() => typeof (window as unknown as HarnessWindow).gc)).toBe('function')
  const baseline = await snapshot(page)
  // The probes see the shell's own keydown listener, so they are live.
  expect(baseline.listeners['keydown|false'] ?? 0).toBeGreaterThanOrEqual(1)
  expect(baseline.contexts).toBe(0)

  let firstHeap = -1
  for (let i = 0; i < 20; i++) {
    await launchAndWaitForPlay(page)
    await expect(page.locator('canvas')).toHaveCount(1)
    if (i === 0) {
      firstHeap = await heapAfterGc(page)
      // While playing, the game holds extra window listeners, a ResizeObserver and a live context.
      const playing = await snapshot(page)
      expect(playing.listeners).not.toEqual(baseline.listeners)
      expect(playing.observers).toBeGreaterThan(baseline.observers)
      expect(playing.contexts).toBeGreaterThanOrEqual(1)
      expect(playing.lost.at(-1)).toBe(false)
    }
    await page.waitForTimeout(500)
    await escapeHome(page)
    await expect(page.locator('canvas')).toHaveCount(0)
    // Dispose must give back everything it took: listeners, observers, and every GL context.
    const after = await snapshot(page)
    expect(after.listeners, `launch ${i + 1}: window listeners`).toEqual(baseline.listeners)
    expect(after.observers, `launch ${i + 1}: ResizeObservers`).toBe(baseline.observers)
    expect(after.contexts, `launch ${i + 1}: GL contexts created`).toBeGreaterThanOrEqual(i + 1)
    expect(after.lost.every(Boolean), `launch ${i + 1}: a disposed game's GL context is still alive`).toBe(true)
  }
  expect(firstHeap).toBeGreaterThan(0)

  // Nothing may keep running or emitting telemetry once the game is disposed. 2 s covers one
  // AUTO_FLUSH_MS (2.5 s of game time minus the ≥0.5 s already played) and ~120 frames.
  const before = await snapshot(page)
  const eventsBefore = await page.evaluate(() => (window as unknown as HarnessWindow).__events.length)
  await page.waitForTimeout(2000)
  const quiet = await snapshot(page)
  const eventsAfter = await page.evaluate(() => (window as unknown as HarnessWindow).__events.length)
  expect(eventsAfter - eventsBefore).toBe(0)
  expect(quiet.raf - before.raf, 'requestAnimationFrame still being called after dispose').toBeLessThan(5)

  // Launch #21: the live context must be healthy and be the only game on the page.
  await launchAndWaitForPlay(page)
  await page.waitForTimeout(500)
  const gl = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.gk-root canvas')
    if (!c) return { found: false, lost: true }
    const ctx = c.getContext('webgl2') ?? c.getContext('webgl')
    return { found: true, lost: ctx ? ctx.isContextLost() : true }
  })
  expect(gl).toEqual({ found: true, lost: false })
  await expect(page.locator('canvas')).toHaveCount(1)
  await expect(page.locator('.gk-root')).toHaveCount(1)
  expect(await page.evaluate(() => (window as unknown as HarnessWindow).__shell.current)).toBe('goalkeeper')
  // The game loop is running (so the post-dispose rAF check above measured a real difference).
  const r0 = (await snapshot(page)).raf
  await expect.poll(async () => (await snapshot(page)).raf - r0).toBeGreaterThan(10)

  const heap = await heapAfterGc(page)
  expect(heap).toBeGreaterThan(0)
  expect(heap).toBeLessThan(firstHeap * 2.5)

  const glTrouble = consoleLines.filter((l) => /Too many active WebGL contexts|Context Lost/i.test(l))
  expect(glTrouble).toEqual([])
  expect(pageErrors).toEqual([])

  await escapeHome(page)
})

/**
 * Replaces getUserMedia with a canvas-backed camera. Headless Edge's --use-fake-device-for-media-stream
 * track ends by itself once attached to a <video>, so the real fake device never gets past
 * attachStream ("Camera track ended") and the app's own camera teardown would go untested. A canvas
 * captureStream track stays live until someone calls stop() on it.
 */
async function installFakeCamera(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as HarnessWindow
    w.__tracks = []
    w.__stopped = []
    w.__gumCalls = 0
    const origStop = MediaStreamTrack.prototype.stop
    MediaStreamTrack.prototype.stop = function (this: MediaStreamTrack) {
      w.__stopped?.push(this)
      origStop.call(this)
    }
    MediaDevices.prototype.getUserMedia = async function (this: MediaDevices, c?: MediaStreamConstraints) {
      w.__gumCalls = (w.__gumCalls ?? 0) + 1
      if (!c?.video) throw new DOMException('fake camera: video only', 'NotSupportedError')
      const cv = document.createElement('canvas')
      cv.width = 640
      cv.height = 480
      const g = cv.getContext('2d')
      let n = 0
      const paint = (): void => {
        if (!g) return
        g.fillStyle = `hsl(${(n++ * 7) % 360} 40% 40%)`
        g.fillRect(0, 0, cv.width, cv.height)
      }
      paint()
      const timer = setInterval(paint, 33)
      const stream = cv.captureStream(30)
      for (const t of stream.getTracks()) t.addEventListener('ended', () => clearInterval(timer))
      w.__tracks?.push(...stream.getTracks())
      return stream
    }
  })
}

async function cameraFlow(page: Page): Promise<void> {
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await installFakeCamera(page)

  await page.goto('/tests/gk-shell.html?auto=camera')
  // Precondition: the pose model the pipeline loads is served (also warms the dev server's static path).
  const model = await page.evaluate(async () => {
    const r = await fetch('/models/pose_landmarker_lite.task', { signal: AbortSignal.timeout(45_000) })
    return { status: r.status, bytes: (await r.arrayBuffer()).byteLength }
  })
  expect(model.status).toBe(200)
  expect(model.bytes).toBeGreaterThan(1_000_000)

  const state = (): Promise<{ gum: number; tracks: number; notEnded: number; notStopped: number }> =>
    page.evaluate(() => {
      const w = window as unknown as HarnessWindow
      const tracks = w.__tracks ?? []
      const stopped = w.__stopped ?? []
      return {
        gum: w.__gumCalls ?? 0,
        tracks: tracks.length,
        notEnded: tracks.filter((t) => t.readyState !== 'ended').length,
        notStopped: tracks.filter((t) => !stopped.includes(t)).length,
      }
    })

  for (let round = 1; round <= 2; round++) {
    await openGoalkeeper(page)
    const hud = page.locator('.gk-hud')
    await expect(hud, `round ${round}: camera path must reach calibration`).toHaveAttribute('data-view', 'calibration', {
      timeout: 90_000,
    })
    // The camera is open and shown: one new live track per round, nothing stopped it yet.
    expect(await state()).toEqual({ gum: round, tracks: round, notEnded: 1, notStopped: 1 })
    await expect(page.locator('video.gk-webcam.gk-live')).toHaveCount(1)
    expect(
      await page.evaluate(() => {
        const v = document.querySelector<HTMLVideoElement>('video.gk-webcam')
        const w = window as unknown as HarnessWindow
        return v?.srcObject instanceof MediaStream && v.srcObject.getVideoTracks()[0] === w.__tracks?.at(-1)
      }),
    ).toBe(true)

    await escapeHome(page)
    expect(await page.evaluate(() => (window as unknown as HarnessWindow).__shell.current)).toBeNull()
    // Dispose must stop() the camera itself (the canvas track never ends on its own).
    await expect.poll(state).toEqual({ gum: round, tracks: round, notEnded: 0, notStopped: 0 })
    const videos = await page.evaluate(
      () => [...document.querySelectorAll('video')].filter((v) => v.srcObject instanceof MediaStream).length,
    )
    expect(videos).toBe(0)
  }
  expect(pageErrors).toEqual([])
}
