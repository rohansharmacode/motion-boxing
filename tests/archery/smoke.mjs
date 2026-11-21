// Headless browser smoke test for Aero Bow (archery). Dev-only, not part of `node --test`.
//
//   npx vite --port 5221 --strictPort &      (start the dev server yourself)
//   node tests/archery/smoke.mjs [baseUrl] [section...]
//
// baseUrl defaults to http://localhost:5221. Sections: desktop shell camera mobile (default: all).
// Needs Playwright (require('playwright')). Screenshots go to $SMOKE_SCREENS
// (default /mnt/project-files/aero-bow/screens), JSON results to $SMOKE_OUT (default: stdout only).
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const args = process.argv.slice(2)
const BASE = args[0] && args[0].startsWith('http') ? args.shift() : 'http://localhost:5221'
const SECTIONS = args.length > 0 ? args : ['desktop', 'shell', 'camera', 'mobile']
const SHOTS = process.env.SMOKE_SCREENS ?? '/mnt/project-files/aero-bow/screens'
mkdirSync(SHOTS, { recursive: true })

// The MediaPipe WASM comes from jsDelivr. If the sandbox blocks it, serve the installed copy instead
// (same version, see src/pose/pipeline.ts WASM_BASE). Set SMOKE_LIVE_CDN=1 to skip the stand-in.
const LOCAL_WASM = fileURLToPath(new URL('../../node_modules/@mediapipe/tasks-vision/wasm/', import.meta.url))
async function routeWasm(ctx) {
  if (process.env.SMOKE_LIVE_CDN || !existsSync(LOCAL_WASM)) return
  await ctx.route('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@*/wasm/**', (route) => {
    const file = route.request().url().split('/').pop().split('?')[0]
    const path = LOCAL_WASM + file
    if (!existsSync(path)) return route.fallback()
    const type = file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'
    return route.fulfill({ status: 200, contentType: type, body: readFileSync(path), headers: { 'access-control-allow-origin': '*' } })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = { base: BASE, sections: {} }
const problems = []
function check(section, ok, label, extra) {
  const line = `${ok ? 'PASS' : 'FAIL'} [${section}] ${label}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`
  console.log(line)
  if (!ok) problems.push(line)
}

/** Records motion-events with a page timestamp, before any module runs. */
const INIT = () => {
  window.__ev = []
  window.addEventListener('motion-event', (e) => {
    const d = e.detail ?? {}
    window.__ev.push({ t: Math.round(performance.now()), type: d.event_type, sport: d.sport, metrics: d.metrics })
  })
  // AudioContext census: count constructions and closes.
  const AC = window.AudioContext
  if (AC) {
    window.__ac = { made: 0, closed: 0 }
    const origClose = AC.prototype.close
    AC.prototype.close = function (...a) {
      window.__ac.closed++
      return origClose.apply(this, a)
    }
    window.AudioContext = class extends AC {
      constructor(...a) {
        super(...a)
        window.__ac.made++
      }
    }
  }
  // getUserMedia census: track live video tracks.
  const md = navigator.mediaDevices
  if (md && md.getUserMedia) {
    window.__tracks = []
    const orig = md.getUserMedia.bind(md)
    md.getUserMedia = async (c) => {
      const s = await orig(c)
      for (const t of s.getTracks()) window.__tracks.push(t)
      return s
    }
  }
}

function attachLogs(page) {
  const log = { console: [], pageErrors: [], failed: [], http: [] }
  page.on('console', (m) => {
    const type = m.type()
    if (type === 'error' || type === 'warning') log.console.push(`${type}: ${m.text()}`)
  })
  page.on('pageerror', (e) => log.pageErrors.push(String(e && e.stack ? e.stack : e)))
  page.on('requestfailed', (r) => log.failed.push(`${r.url()} :: ${r.failure()?.errorText}`))
  page.on('response', (r) => {
    if (r.status() >= 400) log.http.push(`${r.status()} ${r.url()}`)
  })
  return log
}

const events = (page) => page.evaluate(() => window.__ev.slice())
const count = async (page, type, pred = () => true) => (await events(page)).filter((e) => e.type === type && pred(e)).length
const view = (page) => page.evaluate(() => document.querySelector('.ar-hud')?.dataset.view ?? null)
const aiming = (page) => page.evaluate(() => !!document.querySelector('.ar-hint.ar-on'))

async function waitFor(page, fn, timeout = 8000, step = 50) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true
    await sleep(step)
  }
  return false
}

async function canvasCentre(page) {
  const b = await page.locator('.ar-stage canvas').first().boundingBox()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

/**
 * One mouse arrow: wait for aiming, hold ~holdMs over the canvas centre, release.
 * Returns the ARROW_RELEASE event (or null) plus a slow-mo screenshot hook.
 */
async function mouseArrow(page, { holdMs = 1300, onRelease } = {}) {
  if (!(await waitFor(page, () => aiming(page), 10000))) return null
  const before = await count(page, 'ARROW_RELEASE')
  const c = await canvasCentre(page)
  await page.mouse.move(c.x + 1, c.y + 1)
  await page.mouse.move(c.x, c.y)
  await page.mouse.down()
  await sleep(holdMs)
  await page.mouse.up()
  const ok = await waitFor(page, async () => (await count(page, 'ARROW_RELEASE')) > before, 3000, 20)
  if (!ok) return null
  const ev = (await events(page)).filter((e) => e.type === 'ARROW_RELEASE').at(-1)
  if (onRelease) await onRelease(ev)
  return ev
}

async function waitLanded(page, timeout = 8000) {
  // Landed = no longer in flight: aiming again, or end screen.
  return waitFor(page, async () => (await aiming(page)) || (await view(page)) === 'end', timeout, 50)
}

// ------------------------------------------------------------------ desktop
async function desktop(browser) {
  const S = 'desktop'
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
  await ctx.addInitScript(INIT)
  const page = await ctx.newPage()
  const log = attachLogs(page)
  const out = { arrows: [] }
  await page.goto(`${BASE}/archery.html?auto=mouse&debug`, { waitUntil: 'load' })
  check(S, await waitFor(page, async () => (await view(page)) === 'play', 8000), 'auto=mouse reaches play view')
  check(S, await page.evaluate(() => document.querySelector('.ar-debug')?.classList.contains('ar-open')), '?debug opens debug panel')

  // Full 5-arrow round.
  let slowShot = false
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now()
    const ev = await mouseArrow(page, {
      onRelease: async (e) => {
        if (e?.metrics?.bullseye && !slowShot) {
          slowShot = true
          await sleep(300)
          const ts = await page.evaluate(() => {
            const dd = [...document.querySelectorAll('.ar-debug dt')].find((d) => d.textContent === 'timeScale')
            return dd?.nextElementSibling?.textContent ?? null
          })
          out.slowmoTimeScale = ts
          await page.screenshot({ path: `${SHOTS}/smoke-slowmo.png` })
        }
      },
    })
    const landed = await waitLanded(page)
    out.arrows.push({ i, score: ev?.metrics?.score ?? null, landedMs: Date.now() - t0, tension: ev?.metrics?.tension, landed })
    if (i === 1) await page.screenshot({ path: `${SHOTS}/smoke-play.png` })
  }
  check(S, await waitFor(page, async () => (await view(page)) === 'end', 6000), 'end screen after 5 arrows')
  await sleep(600)
  await page.screenshot({ path: `${SHOTS}/smoke-end.png` })
  let ev = await events(page)
  const rel = ev.filter((e) => e.type === 'ARROW_RELEASE').length
  const sum = ev.filter((e) => e.type === 'TICK' && e.metrics?.summary === true)
  check(S, rel === 5, '5 ARROW_RELEASE', rel)
  check(S, sum.length === 1, 'exactly 1 summary TICK', sum.length)
  out.summary = sum[0]?.metrics
  out.slowmo = slowShot
  const endText = await page.locator('.ar-end').innerText()
  out.endText = endText

  // Shoot again.
  await page.getByRole('button', { name: 'Shoot again' }).click()
  check(S, await waitFor(page, async () => (await view(page)) === 'play', 3000), 'Shoot again returns to play')
  // Short click: let-down, no shot.
  await waitFor(page, () => aiming(page), 5000)
  const c = await canvasCentre(page)
  const r0 = await count(page, 'ARROW_RELEASE')
  await page.mouse.move(c.x, c.y)
  await page.mouse.down()
  await sleep(150)
  await page.mouse.up()
  await sleep(1500)
  check(S, (await count(page, 'ARROW_RELEASE')) === r0, 'short click is a let-down (no shot)')
  check(S, await aiming(page), 'still aiming after let-down')

  // Space-hold shot.
  await page.locator('body').focus().catch(() => {})
  await page.mouse.move(c.x, c.y)
  await page.keyboard.down('Space')
  await sleep(1300)
  await page.keyboard.up('Space')
  check(S, await waitFor(page, async () => (await count(page, 'ARROW_RELEASE')) === r0 + 1, 2000), 'Space-hold shoots')
  await waitLanded(page)

  // Space after clicking "Shoot again": focus sits on a hidden button?
  out.activeAfterAgain = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80) ?? null)

  // R restart mid-round.
  const sumBefore = await count(page, 'TICK', (e) => e.metrics?.summary === true)
  await page.keyboard.press('KeyR')
  await sleep(400)
  const pipText = await page.locator('.ar-pips').innerText()
  check(S, !/\d/.test(pipText.replace(/\s/g, '')) || !pipText.includes('10'), 'R clears the scoreboard', pipText)
  check(S, (await count(page, 'TICK', (e) => e.metrics?.summary === true)) === sumBefore, 'R mid-round emits no summary')
  const counter = await page.locator('.ar-counter').innerText()
  check(S, counter.includes('1/5'), 'R resets to arrow 1', counter)

  // R during flight: release then restart immediately.
  const ev2 = await mouseArrow(page)
  await page.keyboard.press('KeyR')
  await sleep(1200)
  out.rDuringFlight = {
    released: !!ev2,
    counter: await page.locator('.ar-counter').innerText(),
    pips: await page.locator('.ar-pips').innerText(),
    shotLayer: await page.locator('.ar-shots').innerText(),
  }

  // M mute.
  await page.keyboard.press('KeyM')
  await sleep(100)
  out.muteCallout = await page.locator('.ar-callouts').innerText()
  await page.keyboard.press('KeyM')
  await sleep(100)
  out.unmuteCallout = await page.locator('.ar-callouts').innerText()
  check(S, out.muteCallout.includes('SOUND OFF') && out.unmuteCallout.includes('SOUND ON'), 'M toggles mute callouts', [out.muteCallout, out.unmuteCallout])

  // D toggling: off -> camera mode (no camera) -> on.
  await page.keyboard.press('KeyD')
  await sleep(300)
  out.dOff = {
    badge: await page.locator('.ar-badge').innerText(),
    callout: await page.locator('.ar-callouts').innerText(),
    hint: await page.locator('.ar-hint').innerText(),
    view: await view(page),
  }
  await page.screenshot({ path: `${SHOTS}/smoke-d-off.png` })
  // Holding the mouse in camera mode must not shoot.
  const r1 = await count(page, 'ARROW_RELEASE')
  await page.mouse.down()
  await sleep(1300)
  await page.mouse.up()
  await sleep(500)
  check(S, (await count(page, 'ARROW_RELEASE')) === r1, 'mouse hold with D off does not shoot')
  await page.keyboard.press('KeyD')
  await sleep(300)
  out.dOn = { badge: await page.locator('.ar-badge').innerText() }
  check(S, out.dOn.badge.includes('MOUSE'), 'D back on shows MOUSE badge', out.dOn.badge)
  const ev3 = await mouseArrow(page)
  check(S, !!ev3, 'mouse shot works after D off/on')
  await waitLanded(page)

  // Backquote debug panel.
  await page.keyboard.press('Backquote')
  await sleep(150)
  const closed = await page.evaluate(() => !document.querySelector('.ar-debug')?.classList.contains('ar-open'))
  await page.keyboard.press('Backquote')
  await sleep(300)
  const reopened = await page.evaluate(() => document.querySelector('.ar-debug')?.classList.contains('ar-open'))
  const rows = await page.locator('.ar-debug dt').count()
  check(S, closed && reopened && rows > 5, 'Backquote toggles debug panel', { closed, reopened, rows })

  // Second full round to check summary count again via R then 5 arrows (quick check of counts per round).
  await page.keyboard.press('KeyR')
  for (let i = 0; i < 5; i++) {
    await mouseArrow(page)
    await waitLanded(page)
  }
  await waitFor(page, async () => (await view(page)) === 'end', 6000)
  ev = await events(page)
  out.totalSummaries = ev.filter((e) => e.type === 'TICK' && e.metrics?.summary === true).length
  check(S, out.totalSummaries === 2, 'second round gives the second summary', out.totalSummaries)
  out.ticks = ev.filter((e) => e.type === 'TICK' && !e.metrics?.summary).length
  out.eventTypes = [...new Set(ev.map((e) => e.type))]
  out.audio = await page.evaluate(() => window.__ac)

  // Home on the dev page reloads.
  out.log = log
  check(S, log.pageErrors.length === 0, 'no page errors', log.pageErrors)
  results.sections[S] = out
  await ctx.close()
}

// ------------------------------------------------------------------ shell
async function shellRun(browser) {
  const S = 'shell'
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
  await ctx.addInitScript(INIT)
  await ctx.addInitScript(() => {
    try {
      localStorage.removeItem('motion-sports.records.v1')
    } catch {}
  })
  const page = await ctx.newPage()
  const log = attachLogs(page)
  const out = {}
  await page.goto(`${BASE}/tests/ar-shell.html`, { waitUntil: 'load' })
  await sleep(500)
  const best = () => page.evaluate(() => document.querySelector('.shell-tile[data-id="archery"] .shell-tile-best')?.textContent ?? null)
  out.bestBefore = await best()
  const gameView = () => page.evaluate(() => !!document.querySelector('.shell-host .ar-root'))
  const gkView = () => page.evaluate(() => !!document.querySelector('.shell-host .gk-root'))

  // Keyboard: focus moves with arrows, Enter launches.
  let focused = null
  for (let i = 0; i < 8 && focused !== 'archery'; i++) {
    await page.keyboard.press('ArrowRight')
    await sleep(80)
    focused = await page.evaluate(() => document.activeElement?.dataset?.id ?? null)
  }
  if (focused !== 'archery') {
    for (let i = 0; i < 8 && focused !== 'archery'; i++) {
      await page.keyboard.press('ArrowDown')
      await sleep(80)
      focused = await page.evaluate(() => document.activeElement?.dataset?.id ?? null)
    }
  }
  check(S, focused === 'archery', 'arrow keys reach the Archery tile', focused)
  await page.keyboard.press('Enter')
  check(S, await waitFor(page, gameView, 5000), 'Enter launches archery')
  // Start screen -> mouse.
  await page.getByRole('button', { name: 'Play with mouse' }).click()
  check(S, await waitFor(page, async () => (await view(page)) === 'play', 3000), 'Play with mouse reaches play view')
  const ev = await mouseArrow(page)
  check(S, !!ev, 'one mouse arrow in shell', ev?.metrics?.score)
  await waitLanded(page)
  // Shell Home pill.
  const nBefore = (await events(page)).length
  await page.locator('.shell-home').click()
  await sleep(1500)
  const nAfter = (await events(page)).length
  check(S, !(await gameView()), 'shell Home disposes archery')
  out.eventsAfterHome = (await events(page)).slice(nBefore).map((e) => `${e.type}${e.metrics?.summary ? '(summary)' : ''}`)
  // A dispose flush of pending ticks is fine; anything after +1.5 s is not.
  await sleep(1500)
  check(S, (await events(page)).length === nAfter, 'no events after dispose', (await events(page)).length - nAfter)
  out.bestAfterPartial = await best()

  // 15 relaunches with goalkeeper in between.
  const launch = async (id) => {
    await page.evaluate((i) => window.__shell.launch(i), id)
    await waitFor(page, id === 'archery' ? gameView : async () => !(await page.evaluate(() => document.querySelector('.shell-host')?.childElementCount === 0)), 5000)
    await sleep(700)
  }
  for (let i = 0; i < 15; i++) {
    await launch('archery')
    if (i % 2 === 0) {
      await page.getByRole('button', { name: 'Play with mouse' }).click().catch(() => {})
      await sleep(300)
    }
    await page.evaluate(() => window.__shell.goHome())
    await sleep(200)
    if (i % 5 === 2) {
      await launch('goalkeeper')
      out.gkLaunched = (out.gkLaunched ?? 0) + ((await gkView()) ? 1 : 0)
      await page.evaluate(() => window.__shell.goHome())
      await sleep(200)
    }
  }
  // Final launch: play a full round and check the personal best line.
  await launch('archery')
  await page.getByRole('button', { name: 'Play with mouse' }).click()
  await waitFor(page, async () => (await view(page)) === 'play', 3000)
  for (let i = 0; i < 5; i++) {
    await mouseArrow(page)
    await waitLanded(page)
  }
  check(S, await waitFor(page, async () => (await view(page)) === 'end', 6000), 'full round in shell after 16 launches')
  const live = await page.evaluate(() => {
    const c = document.querySelector('.shell-host canvas')
    const gl = c && (c.getContext('webgl2') || c.getContext('webgl'))
    return { canvases: document.querySelectorAll('canvas').length, lost: gl ? gl.isContextLost() : null }
  })
  out.liveCanvas = live
  check(S, live.lost === false, 'last archery GL context alive', live)
  await page.screenshot({ path: `${SHOTS}/smoke-shell-end.png` })
  // In-game Home button on the end screen (embedded: should call ctx.exit()).
  const endHome = page.locator('.ar-end').getByRole('button', { name: 'Home' })
  out.endHomeButtons = await endHome.count()
  if (out.endHomeButtons > 0) await endHome.first().click()
  else await page.locator('.shell-home').click()
  await sleep(1500)
  out.bestAfterRound = await best()
  check(S, out.bestAfterRound !== out.bestBefore, 'dashboard best line updates after a finished round', [out.bestBefore, out.bestAfterRound])
  await page.screenshot({ path: `${SHOTS}/smoke-shell-home.png` })
  out.audio = await page.evaluate(() => window.__ac)
  out.records = await page.evaluate(() => localStorage.getItem('motion-sports.records.v1'))
  out.webglWarnings = log.console.filter((l) => /Too many active WebGL|Context Lost/i.test(l))
  out.audioWarnings = log.console.filter((l) => /AudioContext/i.test(l))
  check(S, out.webglWarnings.length === 0, 'no WebGL context warnings', out.webglWarnings.slice(0, 3))
  out.log = log
  check(S, log.pageErrors.length === 0, 'no page errors', log.pageErrors)
  results.sections[S] = out
  await ctx.close()
}

// ------------------------------------------------------------------ camera
async function camera(browser) {
  const S = 'camera'
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, permissions: ['camera'] })
  await ctx.addInitScript(INIT)
  await routeWasm(ctx)
  const page = await ctx.newPage()
  const log = attachLogs(page)
  const out = {}
  await page.goto(`${BASE}/tests/ar-shell.html?debug`, { waitUntil: 'load' })
  await sleep(400)
  await page.evaluate(() => window.__shell.launch('archery'))
  await waitFor(page, () => page.evaluate(() => !!document.querySelector('.ar-root')), 5000)
  await page.getByRole('button', { name: 'Play with camera' }).click()
  const reached = await waitFor(page, async () => (await view(page)) === 'calibration' || (await view(page)) === 'error', 45000, 200)
  out.view = await view(page)
  out.calibText = await page.locator('.ar-calib').innerText().catch(() => null)
  out.errorText = await page.locator('.ar-error').innerText().catch(() => null)
  check(S, reached && out.view === 'calibration', 'camera reaches calibration view', { view: out.view, err: out.errorText })
  await sleep(2000)
  out.calibText2 = await page.locator('.ar-calib').innerText().catch(() => null)
  await page.screenshot({ path: `${SHOTS}/smoke-camera-calib.png` })
  out.tracksLive = await page.evaluate(() => (window.__tracks ?? []).filter((t) => t.readyState === 'live').length)
  // D to mouse.
  await page.keyboard.press('KeyD')
  const playing = await waitFor(page, async () => (await view(page)) === 'play', 3000)
  out.viewAfterD = await view(page)
  check(S, playing, 'D from calibration switches to mouse play', out.viewAfterD)
  // The HUD must stay on play: pose frames keep arriving while calibration is unfinished.
  await sleep(2500)
  out.viewAfterD2500 = await view(page)
  check(S, out.viewAfterD2500 === 'play', 'HUD stays on play 2.5 s after D (not back to calibration)', out.viewAfterD2500)
  out.tracksLiveAfterD = await page.evaluate(() => (window.__tracks ?? []).filter((t) => t.readyState === 'live').length)
  // Headless CPU inference blocks the main thread for ~1 s per pose frame and the game caps dt at 100 ms,
  // so the draw fills ~4x slower here than on a real laptop: hold longer.
  const ev = await mouseArrow(page, { holdMs: 5000 })
  check(S, !!ev, 'mouse arrow after D', ev?.metrics?.source)
  await waitLanded(page)
  await page.screenshot({ path: `${SHOTS}/smoke-camera-d-mouse.png` })
  await page.evaluate(() => window.__shell.goHome())
  await sleep(800)
  out.tracksLiveAfterExit = await page.evaluate(() => (window.__tracks ?? []).filter((t) => t.readyState === 'live').length)
  check(S, out.tracksLiveAfterExit === 0, 'camera released on exit', out.tracksLiveAfterExit)

  // Relaunch camera after exit (pipeline singleton restart).
  await page.evaluate(() => window.__shell.launch('archery'))
  await waitFor(page, () => page.evaluate(() => !!document.querySelector('.ar-root')), 5000)
  await page.getByRole('button', { name: 'Play with camera' }).click()
  const again = await waitFor(page, async () => (await view(page)) === 'calibration' || (await view(page)) === 'error', 30000, 200)
  out.relaunchView = await view(page)
  check(S, again && out.relaunchView === 'calibration', 'camera relaunch reaches calibration', out.relaunchView)
  out.tracksLiveRelaunch = await page.evaluate(() => (window.__tracks ?? []).filter((t) => t.readyState === 'live').length)
  // Exit during calibration via Esc.
  await page.keyboard.press('Escape')
  await sleep(800)
  out.tracksLiveAfterEsc = await page.evaluate(() => (window.__tracks ?? []).filter((t) => t.readyState === 'live').length)
  check(S, out.tracksLiveAfterEsc === 0, 'camera released after Esc in calibration', out.tracksLiveAfterEsc)

  // Exit while the camera is still starting (loading view).
  await page.evaluate(() => window.__shell.launch('archery'))
  await waitFor(page, () => page.evaluate(() => !!document.querySelector('.ar-root')), 5000)
  await page.getByRole('button', { name: 'Play with camera' }).click()
  await sleep(150)
  out.viewWhileStarting = await view(page)
  await page.evaluate(() => window.__shell.goHome())
  await sleep(6000)
  out.tracksLiveAfterEarlyExit = await page.evaluate(() => (window.__tracks ?? []).filter((t) => t.readyState === 'live').length)
  check(S, out.tracksLiveAfterEarlyExit === 0, 'camera released after exit during startup', out.tracksLiveAfterEarlyExit)

  out.log = log
  check(S, log.pageErrors.length === 0, 'no page errors', log.pageErrors)
  results.sections[S] = out
  await ctx.close()
}

// ------------------------------------------------------------------ mobile
async function mobile(browser) {
  const S = 'mobile'
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true })
  await ctx.addInitScript(INIT)
  const page = await ctx.newPage()
  const log = attachLogs(page)
  const out = {}
  const overflow = () =>
    page.evaluate(() => {
      const de = document.documentElement
      const wide = [...document.querySelectorAll('.ar-root *')]
        .filter((n) => {
          const r = n.getBoundingClientRect()
          const cs = getComputedStyle(n)
          return r.width > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && (r.right > innerWidth + 1 || r.left < -1)
        })
        .slice(0, 8)
        .map((n) => `${n.className || n.tagName} ${Math.round(n.getBoundingClientRect().left)}..${Math.round(n.getBoundingClientRect().right)}`)
      return { scrollW: de.scrollWidth, clientW: de.clientWidth, bodyScrollW: document.body.scrollWidth, wide }
    })
  await page.goto(`${BASE}/archery.html`, { waitUntil: 'load' })
  await sleep(800)
  out.start = await overflow()
  await page.screenshot({ path: `${SHOTS}/smoke-mobile-start.png` })
  check(S, out.start.scrollW <= 360 && out.start.bodyScrollW <= 360, 'start screen no horizontal overflow', out.start)
  await page.getByRole('button', { name: 'Play with mouse' }).tap()
  await waitFor(page, async () => (await view(page)) === 'play', 3000)
  // Touch-hold shot via CDP touch events.
  await waitFor(page, () => aiming(page), 5000)
  const c = await canvasCentre(page)
  const cdp = await ctx.newCDPSession(page)
  const r0 = await count(page, 'ARROW_RELEASE')
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y }] })
  for (let i = 0; i < 13; i++) {
    await sleep(100)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x, y: c.y + (i % 2) }] })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  out.touchShot = await waitFor(page, async () => (await count(page, 'ARROW_RELEASE')) > r0, 3000)
  check(S, out.touchShot, 'touch hold shoots')
  await sleep(500)
  out.play = await overflow()
  await page.screenshot({ path: `${SHOTS}/smoke-mobile-play.png` })
  check(S, out.play.scrollW <= 360 && out.play.bodyScrollW <= 360, 'play view no horizontal overflow', out.play)
  for (let i = 0; i < 4; i++) {
    await waitLanded(page)
    await waitFor(page, () => aiming(page), 6000)
    const r = await count(page, 'ARROW_RELEASE')
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y }] })
    await sleep(1300)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await waitFor(page, async () => (await count(page, 'ARROW_RELEASE')) > r, 3000)
  }
  await waitFor(page, async () => (await view(page)) === 'end', 8000)
  await sleep(600)
  out.end = await overflow()
  out.endView = await view(page)
  await page.screenshot({ path: `${SHOTS}/smoke-mobile-end.png` })
  check(S, out.end.scrollW <= 360, 'end view no horizontal overflow', out.end)
  out.log = log
  check(S, log.pageErrors.length === 0, 'no page errors', log.pageErrors)
  results.sections[S] = out
  await ctx.close()
}

const RUN = { desktop, shell: shellRun, camera, mobile }
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
try {
  for (const s of SECTIONS) {
    try {
      await RUN[s](browser)
    } catch (err) {
      check(s, false, 'section threw', String(err && err.stack ? err.stack : err))
    }
  }
} finally {
  await browser.close()
}
results.problems = problems
if (process.env.SMOKE_OUT) writeFileSync(process.env.SMOKE_OUT, JSON.stringify(results, null, 2))
console.log(`\n${problems.length === 0 ? 'ALL PASS' : `${problems.length} FAIL`}`)
process.exitCode = problems.length === 0 ? 0 : 1
