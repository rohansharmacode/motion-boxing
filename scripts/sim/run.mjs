#!/usr/bin/env node
// Headless playtest simulator: runs the real app in Chromium (Playwright) with the webcam + MediaPipe
// replaced by scripts/sim/mockPipeline.js, and drives it with recorded landmark takes (recordings/*.json.gz
// from the motion lab) or synthetic poses. Saves a video, screenshots and a JSON report.
//
//   npm run sim -- boxing                 full boxing fight from real recordings, to KO or time
//   npm run sim -- all                    boxing, then a quick pass on every other sport
//   npm run sim -- goalkeeper archery     only these
// Options (env): SIM_URL (default: starts vite on :5199), SIM_OUT (default sim-out/), SIM_REC (default recordings/),
//   SIM_CHROME (Chromium executable), SIM_W/SIM_H (viewport, default 960x540), SIM_HEADED=1.
import { chromium } from 'playwright'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { synthPose, guardBase } from './synth.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = path.resolve(process.env.SIM_OUT ?? path.join(ROOT, 'sim-out'))
const REC = path.resolve(process.env.SIM_REC ?? path.join(ROOT, 'recordings'))
const W = Number(process.env.SIM_W ?? 960)
const H = Number(process.env.SIM_H ?? 540)
const MOCK = fs.readFileSync(path.join(ROOT, 'scripts/sim/mockPipeline.js'), 'utf8')
const SPORTS = ['boxing', 'goalkeeper', 'archery', 'bowling', 'tabletennis', 'tennis']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- recordings ----------
function loadTakes(game) {
  if (!fs.existsSync(REC)) return []
  return fs
    .readdirSync(REC)
    .filter((f) => f.startsWith(game + '_') && f.endsWith('.json.gz'))
    .sort()
    .map((f) => ({ file: f, ...JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(REC, f))).toString()) }))
}

/** Queue items for frames of a take between t0 and t1 (recording ms). Null frames keep the last spacing. */
function slice(take, t0, t1, label) {
  const items = []
  let prev = null
  let first = true
  for (const f of take.frames) {
    const t = f ? f[0] : prev === null ? null : prev + 33
    if (t === null) continue
    if (t < t0 || t > t1) { prev = t; continue }
    const dt = first ? 33 : Math.max(1, t - prev)
    items.push({ dt, pose: f, label: first ? label : undefined })
    first = false
    prev = t
  }
  return items
}

/** The take's opening (camera start + guard hold) up to its first segment: feeds the real calibrator. */
function opening(take) {
  const s = take.segments[0]
  return slice(take, -Infinity, s ? s.startT : take.frames.at(-1)[0], 'calibrate')
}
const segmentItems = (take, s) => slice(take, s.startT, s.endT, s.label)

/**
 * The longest run of real frames with both fists up (wrists above shoulder line + 0.05) and visible,
 * played forward then backward so it can loop smoothly as a calibration hold.
 */
function guardHold(takes) {
  let best = []
  for (const take of takes) {
    let run = []
    for (const f of take.frames) {
      const ok = f && [5, 6].every((k) => f[1][k * 4 + 3] > 60 && f[1][k * 4 + 1] < Math.max(f[1][1 * 4 + 1], f[1][2 * 4 + 1]) + 50)
      if (ok) run.push(f)
      else { if (run.length > best.length) best = run; run = [] }
    }
    if (run.length > best.length) best = run
  }
  best = best.slice(0, 120)
  const there = best.map((f) => ({ dt: 33, pose: f }))
  return [...there, ...[...there].reverse()].map((it, i) => (i === 0 ? { ...it, label: 'calibrate' } : it))
}

// ---------- browser ----------
async function startVite() {
  if (process.env.SIM_URL) return { url: process.env.SIM_URL, stop() {} }
  const proc = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', '5199', '--strictPort'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('vite did not start')), 30000)
    proc.stdout.on('data', (d) => { if (String(d).includes('Local')) { clearTimeout(t); res() } })
    proc.on('exit', (c) => rej(new Error('vite exited ' + c)))
  })
  return { url: 'http://localhost:5199', stop: () => proc.kill() }
}

async function newPage(browser, name) {
  const dir = path.join(OUT, name)
  fs.mkdirSync(dir, { recursive: true })
  const ctx = await browser.newContext({ viewport: { width: W, height: H } })
  const page = await ctx.newPage()
  // Video: CDP screencast frames (works without Playwright's own ffmpeg), stitched by system ffmpeg at the end.
  const framesDir = path.join(dir, 'frames')
  fs.rmSync(framesDir, { recursive: true, force: true })
  fs.mkdirSync(framesDir)
  const cdp = await ctx.newCDPSession(page)
  let nFrames = 0
  const t0 = Date.now()
  cdp.on('Page.screencastFrame', (f) => {
    fs.writeFileSync(path.join(framesDir, String(++nFrames).padStart(5, '0') + '.jpg'), Buffer.from(f.data, 'base64'))
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: W, maxHeight: H, everyNthFrame: 1 })
  const video = { framesDir, count: () => nFrames, seconds: () => (Date.now() - t0) / 1000 }
  const log = { errors: [], warnings: [], events: [] }
  page.on('pageerror', (e) => log.errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') log.errors.push(m.text())
    else if (m.type() === 'warning') log.warnings.push(m.text())
  })
  await page.route(/\/src\/pose\/pipeline\.ts/, (r) => r.fulfill({ body: MOCK, contentType: 'application/javascript' }))
  await page.addInitScript(() => {
    localStorage.setItem('motion-sports.boxing-tutorial-done', '1')
    const s = (window.__simStats = { frames: [], events: [] })
    let last = performance.now()
    const raf = (now) => { s.frames.push(now - last); last = now; if (s.frames.length > 4000) s.frames.shift(); requestAnimationFrame(raf) }
    requestAnimationFrame(raf)
    window.addEventListener('motion-event', (e) => {
      const d = e.detail || {}
      s.events.push({ at: performance.now(), label: window.__sim?.label ?? null, type: d.event_type, sport: d.sport, m: d.metrics, hit: d.accuracy_score })
    })
  })
  const shot = (n) => page.screenshot({ path: path.join(dir, n + '.png') })
  return { ctx, page, dir, log, shot, video }
}

const feed = (page, items) => page.evaluate((it) => window.__sim.enqueue(it), items)
const queued = (page) => page.evaluate(() => window.__sim?.queue.length ?? -1)
async function fpsStats(page, sinceIdx = 0) {
  return page.evaluate((i) => {
    const f = window.__simStats.frames.slice(i)
    if (!f.length) return null
    const sorted = [...f].sort((a, b) => a - b)
    const mean = f.reduce((a, b) => a + b, 0) / f.length
    return { fps: Math.round(1000 / mean), p95FrameMs: Math.round(sorted[Math.floor(f.length * 0.95)]), longFrames: f.filter((x) => x > 100).length, n: f.length }
  }, sinceIdx)
}

/** Home -> tile -> (preview Start, when the theme shows a preview). */
async function openSport(page, base, id, query = '') {
  await page.goto(base + '/' + query)
  await page.locator(`.shell-tile[data-id=${id}]`).click()
  const start = page.locator('.ch-btn--start')
  if (await start.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) await start.click()
  await sleep(2500)
}

// ---------- boxing ----------
async function boxing(browser, base) {
  const takes = loadTakes('boxing')
  if (!takes.length) throw new Error(`no boxing recordings in ${REC}`)
  const byLabel = Object.fromEntries(takes.flatMap((t) => t.segments.map((s) => [s.label, segmentItems(t, s)])))
  const s = await newPage(browser, 'boxing')
  const { page, shot, log } = s
  await openSport(page, base, 'boxing')
  await shot('01-start')
  await page.getByRole('button', { name: /start camera/i }).first().dispatchEvent('click')
  const hold = guardHold(takes)
  for (let i = 0; i < 8; i++) {
    await feed(page, hold)
    await sleep(1500)
    if (i === 0) await shot('02-calibrating')
    if (process.env.SIM_DEBUG) console.log(await page.evaluate(() => [document.body.dataset.state, window.__sim.published, [...document.querySelectorAll('[data-status]')].map((e) => e.dataset.status).join()].join(' | ')), log.errors.slice(0, 3))
    await page.waitForFunction(() => window.__sim.queue.length < 20 || ['fighting', 'tutorial'].includes(document.body.dataset.state), null, { timeout: 20000 })
    if (['fighting', 'tutorial'].includes(await page.evaluate(() => document.body.dataset.state))) break
  }
  await page.evaluate(() => window.__sim.clear())
  await page.waitForFunction(() => ['fighting', 'tutorial'].includes(document.body.dataset.state), null, { timeout: 5000 })
  const fightStart = Date.now()
  // Order: punches first, with defence and a disruption in between, then repeat until the round ends.
  const plan = ['jab-L', 'jab-R', 'block', 'hook', 'dodge-L', 'uppercut', '@lost', 'jab-R', 'dodge-R', '@handout', 'jab-L', 'duck', 'idle']
  const timeline = []
  let shots = 0
  for (let loop = 0; loop < 4; loop++) {
    for (const step of plan) {
      const state = await page.evaluate(() => document.body.dataset.state)
      if (state !== 'fighting') break
      let items
      if (step === '@lost') items = [{ dt: 33, pose: null, label: 'tracking-lost' }, ...Array.from({ length: 45 }, () => ({ dt: 33, pose: null }))]
      else if (step === '@handout') items = handOut(byLabel['jab-L'] ?? byLabel['jab-R'])
      else items = byLabel[step]
      if (!items?.length) continue
      const t0 = Date.now()
      const e0 = await page.evaluate(() => window.__simStats.events.length)
      await feed(page, items)
      while ((await queued(page)) > 0 && (await page.evaluate(() => document.body.dataset.state)) === 'fighting') {
        await sleep(400)
        if (shots < 6 && Date.now() - t0 > 2500) { await shot(`03-fight-${String(++shots).padStart(2, '0')}-${step.replace('@', '')}`); }
      }
      const ev = await page.evaluate((i) => window.__simStats.events.slice(i), e0)
      const punches = ev.filter((e) => e.type === 'PUNCH')
      timeline.push({ step, ms: Date.now() - t0, punches: punches.length, kinds: count(punches.map((p) => `${p.m?.punchType}/${p.m?.hand}`)), landed: punches.filter((p) => p.m?.landed).length, otherEvents: count(ev.filter((e) => e.type !== 'PUNCH').map((e) => e.type)) })
      await page.evaluate(() => window.__sim.clear())
    }
  }
  await sleep(4000)
  await shot('04-end')
  const end = await page.evaluate(() => ({ state: document.body.dataset.state, punches: document.body.dataset.punches, text: document.querySelector('.bx-end, [class*=result], [class*=end]')?.textContent?.replace(/\s+/g, ' ').slice(0, 400) }))
  const fps = await fpsStats(page)
  const lag = await page.evaluate(() => { const l = window.__sim.lagMs; return { meanQueueLagMs: Math.round(l.reduce((a, b) => a + b, 0) / l.length), maxQueueLagMs: Math.round(Math.max(...l)) } })
  await s.ctx.close()
  return { sport: 'boxing', fightSeconds: Math.round((Date.now() - fightStart) / 1000), end, fps, lag, timeline, errors: log.errors, warnings: [...new Set(log.warnings)].slice(0, 15), takes: takes.map((t) => t.file), video: videoOf(s) }
}

/** A real punch set with the punching wrist and elbow dropping out of frame for 0.8 s in the middle. */
function handOut(items) {
  if (!items) return null
  const mid = Math.floor(items.length / 2)
  return items.map((it, i) => {
    if (i < mid || i > mid + 24 || !it.pose) return it
    const img = [...it.pose[1]], wld = [...it.pose[2]]
    for (const k of [3, 5, 7, 9, 11, 13, 15, 17]) { img[k * 4 + 3] = 5; wld[k * 4 + 3] = 5; img[k * 4 + 1] = 1100 }
    return { ...it, pose: [it.pose[0], img, wld], label: i === mid ? 'hand-out' : it.label }
  })
}

const count = (arr) => arr.reduce((o, k) => ((o[k] = (o[k] ?? 0) + 1), o), {})
/** Stitches the screencast into run.mp4 (real-time speed) and a short run.gif. Needs ffmpeg on PATH. */
function videoOf(s) {
  const n = s.video.count()
  if (!n) return null
  const rate = Math.max(1, n / s.video.seconds()).toFixed(2)
  const mp4 = path.join(s.dir, 'run.mp4')
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', rate, '-i', path.join(s.video.framesDir, '%05d.jpg'), '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p', mp4])
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-vf', 'fps=6,scale=480:-1:flags=lanczos', '-t', '30', path.join(s.dir, 'run.gif')])
    fs.rmSync(s.video.framesDir, { recursive: true, force: true })
  } catch (err) {
    console.warn('ffmpeg failed, frames kept in', s.video.framesDir, String(err.message ?? err))
    return s.video.framesDir
  }
  return mp4
}

// ---------- quick pass for the other sports ----------
const QUICK = {
  goalkeeper: { moves: ['dive-L', 'dive-R', 'dive-L', 'dive-R', 'idle'] },
  archery: { moves: ['draw-release', 'draw-release', 'draw-release'] },
  bowling: { moves: ['bowl', 'bowl', 'bowl'] },
  tabletennis: { query: '?rkauto', moves: ['swing', 'swing', 'swing', 'swing'] },
  tennis: { query: '?rkauto', moves: ['swing', 'swing', 'swing', 'swing'] },
}

async function quick(browser, base, id) {
  const cfg = QUICK[id]
  const s = await newPage(browser, id)
  const { page, shot, log } = s
  const real = loadTakes(id === 'tabletennis' || id === 'tennis' ? '__none__' : id)
  await openSport(page, base, id, cfg.query)
  await shot('01-start')
  // Each sport has its own start control; press the first visible camera/start button.
  const startBtn = page.locator('button:visible').filter({ hasText: /camera|start|play/i }).first()
  if (await startBtn.count()) await startBtn.click().catch(() => {})
  const base0 = guardBase()
  await feed(page, synthPose('stand', base0, 2500))
  await sleep(3000)
  await shot('02-calibration')
  const used = []
  if (real.length) {
    // Real takes from the motion lab: opening (calibration) and then every labelled set.
    for (const t of real) {
      await feed(page, opening(t))
      for (const sg of t.segments) await feed(page, segmentItems(t, sg))
      used.push(t.file)
    }
  } else {
    for (const m of cfg.moves) await feed(page, synthPose(m, base0))
  }
  let i = 0
  const deadline = Date.now() + 70000
  while ((await queued(page)) > 0 && Date.now() < deadline) {
    await sleep(2500)
    if (i < 4) await shot(`03-play-${++i}`)
  }
  await sleep(2000)
  await shot('04-after')
  const ev = await page.evaluate(() => window.__simStats.events)
  const fps = await fpsStats(page)
  const ui = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 500))
  await s.ctx.close()
  return { sport: id, input: real.length ? 'recordings' : 'synthetic', takes: used, fps, events: count(ev.map((e) => e.type)), ui, errors: log.errors, warnings: [...new Set(log.warnings)].slice(0, 10), video: videoOf(s) }
}

// ---------- main ----------
const want = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const list = !want.length ? ['boxing'] : want.includes('all') ? SPORTS : want
fs.mkdirSync(OUT, { recursive: true })
const vite = await startVite()
const browser = await chromium.launch({
  executablePath: process.env.SIM_CHROME || undefined,
  headless: !process.env.SIM_HEADED,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'],
})
const report = []
try {
  for (const id of list) {
    process.stdout.write(`sim ${id} ... `)
    try {
      const r = id === 'boxing' ? await boxing(browser, vite.url) : await quick(browser, vite.url, id)
      report.push(r)
      console.log(`done (${r.errors.length} errors, ${r.fps?.fps ?? '?'} fps)`)
    } catch (err) {
      report.push({ sport: id, failed: String(err?.stack ?? err) })
      console.log('FAILED', String(err?.message ?? err))
    }
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  }
} finally {
  await browser.close()
  vite.stop()
}
console.log(`report: ${path.join(OUT, 'report.json')}`)
