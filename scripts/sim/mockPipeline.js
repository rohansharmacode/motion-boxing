// Drop-in replacement for src/pose/pipeline.ts, served by the sim harness (scripts/sim/run.mjs) through a
// Playwright route. No webcam, no MediaPipe: PoseFrames come from window.__sim, fed by the harness with
// recorded takes (recordings/*.json.gz) or synthetic poses. Frames keep their recorded spacing and are
// re-stamped onto performance.now(), so detectors see real-time velocities even when rendering is slow.
// The <video> shows a stick figure of the current pose so the webcam preview is not blank.
const STORED = [0, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28]
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28]]

function unpack(flat) {
  const out = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }))
  STORED.forEach((idx, k) => {
    out[idx] = { x: flat[k * 4] / 1000, y: flat[k * 4 + 1] / 1000, z: flat[k * 4 + 2] / 1000, visibility: flat[k * 4 + 3] / 100 }
  })
  return out
}

const sim = (window.__sim ??= { queue: [], published: 0, nulls: 0, lagMs: [], started: false, current: null, label: null })
/** Queue items: { dt, pose: [t, imageFlat, worldFlat] | null, label? }. dt = ms after the previous item. */
sim.enqueue = (items) => {
  for (const it of items) sim.queue.push(it)
  return sim.queue.length
}
sim.clear = () => {
  sim.queue.length = 0
}

const listeners = new Set()
const endedListeners = new Set()
let timer = 0
let running = false

export function prefetchPoseAssets() {}
export function onPipelineEnded(cb) {
  endedListeners.add(cb)
  return () => endedListeners.delete(cb)
}
export function unpackJoints(packed, _mirror, out = []) {
  return out
}

function drawPose(ctx, frame) {
  const { width: w, height: h } = ctx.canvas
  ctx.fillStyle = '#1b2230'
  ctx.fillRect(0, 0, w, h)
  if (!frame) return
  // The video is the raw (unmirrored) camera; the app mirrors it, so undo the pipeline's mirror here.
  const p = (j) => [(1 - j.x) * w, j.y * h]
  ctx.strokeStyle = '#7cf'
  ctx.lineWidth = 8
  for (const [a, b] of BONES) {
    const A = frame.image[a], B = frame.image[b]
    if (A.visibility < 0.3 || B.visibility < 0.3) continue
    ctx.beginPath(); ctx.moveTo(...p(A)); ctx.lineTo(...p(B)); ctx.stroke()
  }
  const n = frame.image[0]
  if (n.visibility > 0.3) { ctx.fillStyle = '#fc6'; ctx.beginPath(); ctx.arc(...p(n), 26, 0, 7); ctx.fill() }
}

let current = null

/** Like the real pipeline: one shared camera; a second start while running returns the same pipeline. */
export function startPosePipeline(video) {
  current ??= launch(video)
  return current
}

async function launch(video) {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 480
  const ctx = canvas.getContext('2d')
  drawPose(ctx, null)
  video.srcObject = canvas.captureStream(15)
  video.muted = true
  await video.play().catch(() => {})
  running = true
  sim.started = true
  let clock = performance.now()
  let lastT = 0
  let lastDraw = 0
  const tick = () => {
    if (!running) return
    const now = performance.now()
    // Publish every frame that is due; a slow main thread catches up with correctly spaced timestamps.
    while (sim.queue.length && clock + sim.queue[0].dt <= now) {
      const it = sim.queue.shift()
      clock += it.dt
      if (it.label !== undefined) sim.label = it.label
      let frame = null
      if (it.pose) {
        const t = Math.max(clock, lastT + 0.1)
        lastT = t
        frame = { t, image: unpack(it.pose[1]), world: unpack(it.pose[2]) }
      } else sim.nulls++
      sim.current = frame
      sim.published++
      sim.lagMs.push(now - clock)
      if (sim.lagMs.length > 600) sim.lagMs.shift()
      for (const cb of listeners) cb(frame)
    }
    // Idle queue: hold the clock at now so the next item is not published in a burst.
    if (!sim.queue.length) clock = now
    if (now - lastDraw > 66) { lastDraw = now; drawPose(ctx, sim.current) }
  }
  timer = setInterval(tick, 8)
  return {
    video,
    videoWidth: 640,
    videoHeight: 480,
    delegate: 'CPU',
    mode: 'main',
    get inferenceMs() { return 18 },
    subscribe(cb) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
    stop() {
      current = null
      running = false
      sim.started = false
      clearInterval(timer)
      listeners.clear()
    },
  }
}
