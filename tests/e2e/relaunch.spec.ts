// Lifecycle tests against the real shell + goalkeeper with real WebGL (swiftshader):
//  - 20x launch -> Escape (dispose) then one more launch: no WebGL context loss, no DOM/heap leaks,
//    no motion-events after the game is gone.
//  - fake camera path (?auto=camera): reaches calibration (or a graceful error), Escape stops every
//    MediaStreamTrack the page opened.
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

interface HarnessWindow {
  __shell: { current: string | null }
  __events: unknown[]
  gc?: () => void
  __tracks?: MediaStreamTrack[]
  /** Tracks the app called stop() on. */
  __stopped?: MediaStreamTrack[]
}

async function launchAndWaitForPlay(page: Page): Promise<void> {
  await page.locator('.shell-tile[data-id=goalkeeper]').click()
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

test('20x launch → dispose with real WebGL, no leaks', async ({ page }) => {
  test.setTimeout(240_000)
  const consoleLines: string[] = []
  const pageErrors: string[] = []
  page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`))
  page.on('pageerror', (e) => pageErrors.push(e.message))

  await page.goto('/tests/gk-shell.html?auto=mouse')
  await expect(page.locator('.shell-tile[data-id=goalkeeper]')).toHaveAttribute('data-ready', 'true')
  expect(await page.evaluate(() => typeof (window as unknown as HarnessWindow).gc)).toBe('function')

  let firstHeap = -1
  for (let i = 0; i < 20; i++) {
    await launchAndWaitForPlay(page)
    await expect(page.locator('canvas')).toHaveCount(1)
    if (i === 0) firstHeap = await heapAfterGc(page)
    await page.waitForTimeout(500)
    await escapeHome(page)
    await expect(page.locator('canvas')).toHaveCount(0)
  }
  expect(firstHeap).toBeGreaterThan(0)

  // Nothing may keep emitting telemetry once the game is disposed.
  const before = await page.evaluate(() => (window as unknown as HarnessWindow).__events.length)
  await page.waitForTimeout(2000)
  const after = await page.evaluate(() => (window as unknown as HarnessWindow).__events.length)
  expect(after - before).toBe(0)

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

  const heap = await heapAfterGc(page)
  expect(heap).toBeGreaterThan(0)
  expect(heap).toBeLessThan(firstHeap * 2.5)

  const glTrouble = consoleLines.filter((l) => /Too many active WebGL contexts|Context Lost/i.test(l))
  expect(glTrouble).toEqual([])
  expect(pageErrors).toEqual([])

  await escapeHome(page)
})

// Runs in its own fresh Edge process: after the 20x real-WebGL test above, swiftshader in the shared
// browser sometimes never finishes MediaPipe's landmarker setup (the pose_landmarker_lite.task fetch /
// GPU delegate stalls, HUD stays on 'loading'). Seen only in that order, never in isolation.
test('fake camera: ?auto=camera reaches calibration (or a graceful error), Escape ends all tracks', async ({
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

async function cameraFlow(page: Page): Promise<void> {
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  // Record every track handed out by getUserMedia, and every track the app stop()s.
  // Headless Edge's fake capture device ends its track by itself once it is attached to a <video>
  // (and later reports a 2x2 frame), so readyState alone cannot prove the app released the camera:
  // the stop() spy is what makes this test able to fail.
  await page.addInitScript(() => {
    const w = window as unknown as HarnessWindow
    w.__tracks = []
    w.__stopped = []
    const origStop = MediaStreamTrack.prototype.stop
    MediaStreamTrack.prototype.stop = function (this: MediaStreamTrack) {
      w.__stopped?.push(this)
      origStop.call(this)
    }
    const proto = MediaDevices.prototype
    const orig = proto.getUserMedia
    proto.getUserMedia = async function (this: MediaDevices, c?: MediaStreamConstraints) {
      const s = await orig.call(this, c)
      w.__tracks?.push(...s.getTracks())
      return s
    }
  })

  await page.goto('/tests/gk-shell.html?auto=camera')
  // Precondition: the pose model the pipeline loads is served (also warms the dev server's static path).
  const model = await page.evaluate(async () => {
    const r = await fetch('/models/pose_landmarker_lite.task', { signal: AbortSignal.timeout(20_000) })
    return { status: r.status, bytes: (await r.arrayBuffer()).byteLength }
  })
  expect(model.status).toBe(200)
  expect(model.bytes).toBeGreaterThan(1_000_000)
  await page.locator('.shell-tile[data-id=goalkeeper]').click()
  const hud = page.locator('.gk-hud')
  await expect(hud).toHaveAttribute('data-view', /^(calibration|error)$/, { timeout: 90_000 })
  const view = await hud.getAttribute('data-view')
  const tracks = await page.evaluate(() => {
    const w = window as unknown as HarnessWindow
    w.__tracks ??= []
    // Also pick up tracks attached to any page video, in case a stream bypassed the wrapper.
    for (const v of document.querySelectorAll('video')) {
      if (v.srcObject instanceof MediaStream) {
        for (const t of v.srcObject.getTracks()) if (!w.__tracks.includes(t)) w.__tracks.push(t)
      }
    }
    return w.__tracks.map((t) => ({ kind: t.kind, state: t.readyState }))
  })
  if (view === 'calibration') {
    // Calibration means the camera opened: a video track was handed out and the preview shows it.
    expect(tracks.filter((t) => t.kind === 'video').length).toBeGreaterThanOrEqual(1)
    await expect(page.locator('.gk-webcam.gk-live')).toHaveCount(1)
    expect(await page.evaluate(() => document.querySelector<HTMLVideoElement>('video.gk-webcam')?.srcObject instanceof MediaStream)).toBe(true)
    // Nothing stopped the camera yet.
    expect(await page.evaluate(() => (window as unknown as HarnessWindow).__stopped?.length ?? -1)).toBe(0)
  } else {
    await expect(page.locator('.gk-error .gk-error-msg')).not.toBeEmpty()
  }

  await escapeHome(page)
  expect(await page.evaluate(() => (window as unknown as HarnessWindow).__shell.current)).toBeNull()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const w = window as unknown as HarnessWindow
        const tracks = w.__tracks ?? []
        const stopped = w.__stopped ?? []
        return {
          notEnded: tracks.filter((t) => t.readyState !== 'ended').length,
          notStopped: tracks.filter((t) => !stopped.includes(t)).length,
        }
      }),
    )
    .toEqual({ notEnded: 0, notStopped: 0 })
  const videos = await page.evaluate(() =>
    [...document.querySelectorAll('video')].filter((v) => v.srcObject instanceof MediaStream).length,
  )
  expect(videos).toBe(0)
  expect(pageErrors).toEqual([])
}
