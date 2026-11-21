// Singleton webcam + MediaPipe PoseLandmarker loop (research doc section 4, Shared Pose Pipeline).
// Tracking runs in a Web Worker (pose.worker.ts) so rendering never waits on inference: each new camera
// frame becomes a transferred ImageBitmap, frames are skipped while the worker is busy, and results come
// back as packed arrays. If workers or ImageBitmaps are unavailable, or the worker fails to start, the same
// loop runs on the main thread. x is mirrored once here. ?worker=0 forces the main-thread path.
import type { Landmark as RawLandmark, NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision'
import { StartupError } from './types.ts'
import type { Joint, PoseFrame, StartupErrorKind } from './types.ts'
import { LANDMARKS, STRIDE } from './workerProtocol.ts'
import { createFrameClock } from './frameClock.ts'
import type { FrameMeta } from './frameClock.ts'
import type { TrackerAttempt, WorkerRequest, WorkerResponse } from './workerProtocol.ts'

// WASM runtime, bundled from the installed @mediapipe/tasks-vision package so camera play needs no internet
// (venue wifi). Classic loader for the main thread and classic workers, module loader for module workers.
import wasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url'
import wasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url'
import wasmModuleLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url'
import wasmModuleBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url'
import type { WasmFiles } from './workerProtocol.ts'

const WASM: WasmFiles = {
  classic: { wasmLoaderPath: wasmLoaderUrl, wasmBinaryPath: wasmBinaryUrl },
  module: { wasmLoaderPath: wasmModuleLoaderUrl, wasmBinaryPath: wasmModuleBinaryUrl },
}
const absoluteWasm = (): WasmFiles => ({
  classic: { wasmLoaderPath: absolute(WASM.classic.wasmLoaderPath), wasmBinaryPath: absolute(WASM.classic.wasmBinaryPath) },
  module: { wasmLoaderPath: absolute(WASM.module.wasmLoaderPath), wasmBinaryPath: absolute(WASM.module.wasmBinaryPath) },
})
const MODEL_LITE = import.meta.env.BASE_URL + 'models/pose_landmarker_lite.task'
/** The full model tracks arms far better (fewer flipped elbows and lost wrists) and is fast enough on a GPU. */
const MODEL_FULL = import.meta.env.BASE_URL + 'models/pose_landmarker_full.task'
/** ?model=lite or ?model=full forces a model, for slow laptops or testing. */
function modelOverride(): 'lite' | 'full' | null {
  try {
    const m = new URLSearchParams(location.search).get('model')
    return m === 'lite' || m === 'full' ? m : null
  } catch {
    return null
  }
}
/**
 * Detection, presence and tracking confidence. Slightly below MediaPipe's 0.5 defaults so a fast punch with a
 * motion-blurred arm keeps tracking instead of dropping to a fresh (jumpy) detection.
 */
const MIN_DETECTION_CONFIDENCE = 0.5
const MIN_PRESENCE_CONFIDENCE = 0.4
const MIN_TRACKING_CONFIDENCE = 0.4
/** Weight of the newest sample in the inference time average. */
const INFERENCE_EMA = 0.1
/** Safety net so a stalled download can never hang startup. Offline failures reject much sooner. */
const TRACKER_TIMEOUT_MS = 60_000
const METADATA_TIMEOUT_MS = 10_000

export interface PosePipeline {
  readonly video: HTMLVideoElement
  readonly videoWidth: number
  readonly videoHeight: number
  readonly delegate: 'GPU' | 'CPU'
  /** Where tracking runs. */
  readonly mode: 'worker' | 'main'
  /** Moving average of detectForVideo duration, ms. */
  readonly inferenceMs: number
  /** cb gets every processed frame (null when no pose). Returns an unsubscribe function. */
  subscribe(cb: (frame: PoseFrame | null) => void): () => void
  /** Stops camera and tracker. Idempotent. The next startPosePipeline call starts fresh. */
  stop(): void
}

type Delegate = PosePipeline['delegate']
type Tracker = { landmarker: PoseLandmarker; delegate: Delegate }
type Vision = typeof import('@mediapipe/tasks-vision')

let visionModule: Promise<Vision> | null = null

/** Cached dynamic import. A failed import is forgotten so a retry can try again. */
function loadVision(): Promise<Vision> {
  visionModule ??= import('@mediapipe/tasks-vision').catch((err: unknown) => {
    visionModule = null
    throw err
  })
  return visionModule
}

let prefetched = false

/** Warms the HTTP cache for the tracker at low priority. Never starts the camera; errors are ignored. */
export function prefetchPoseAssets(): void {
  if (prefetched) return
  prefetched = true
  const model = modelOverride() === 'lite' ? MODEL_LITE : MODEL_FULL
  const urls = [model, WASM.classic.wasmLoaderPath, WASM.classic.wasmBinaryPath]
  for (const url of urls) {
    // MediaPipe later loads these with CORS and no credentials, so match that to share the cache entry.
    fetch(url, { priority: 'low', mode: 'cors', credentials: 'omit' })
      .then((res) => res.arrayBuffer())
      .catch(() => {})
  }
  loadVision().catch(() => {})
}

const endedListeners = new Set<(reason: string) => void>()

/** cb runs when a running pipeline dies on its own (camera unplugged, track ended). Not on stop(). */
export function onPipelineEnded(cb: (reason: string) => void): () => void {
  endedListeners.add(cb)
  return () => {
    endedListeners.delete(cb)
  }
}

function cameraErrorKind(err: unknown): StartupErrorKind {
  const name = err instanceof Error ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'camera-denied'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'camera-not-found'
  if (name === 'NotReadableError' || name === 'AbortError') return 'camera-in-use'
  return 'camera-other'
}

async function openCamera(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new StartupError('camera-unsupported', 'Camera API unavailable (insecure context or old browser)')
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      // 30 fps keeps motion blur and frame gaps down; most webcams default lower in dim rooms otherwise.
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, min: 15 } },
      audio: false,
    })
  } catch (err) {
    throw new StartupError(cameraErrorKind(err), `Camera failed: ${String(err)}`)
  }
}

/** GPU gets the full model, CPU the lite one (the full model is too slow for 30 fps on most CPUs). */
function trackerAttempts(): Array<{ delegate: Delegate; model: string }> {
  const forced = modelOverride()
  const all: Array<{ delegate: Delegate; model: string }> = [
    { delegate: 'GPU', model: forced === 'lite' ? MODEL_LITE : MODEL_FULL },
    { delegate: 'GPU', model: MODEL_LITE },
    { delegate: 'CPU', model: forced === 'full' ? MODEL_FULL : MODEL_LITE },
  ]
  const seen = new Set<string>()
  return all.filter((a) => {
    const key = a.delegate + a.model
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const absolute = (url: string): string => new URL(url, location.href).href

function workerAllowed(): boolean {
  try {
    if (new URLSearchParams(location.search).get('worker') === '0') return false
  } catch {
    // no location: fall through
  }
  return typeof Worker === 'function' && typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function'
}

interface WorkerTracker {
  worker: Worker
  delegate: Delegate
}

/** Starts pose.worker.ts and waits for its tracker. Rejects (and terminates the worker) on any failure. */
function startWorker(): Promise<WorkerTracker> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('./pose.worker.ts', import.meta.url), { type: 'module', name: 'pose-tracker' })
    } catch (err) {
      reject(err)
      return
    }
    const fail = (why: unknown): void => {
      clearTimeout(timer)
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
      reject(why instanceof Error ? why : new Error(String(why)))
    }
    const timer = setTimeout(() => fail(new Error('Pose worker took too long to start')), TRACKER_TIMEOUT_MS)
    worker.onerror = (e) => fail(new Error(e.message || 'Pose worker failed to load'))
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      if (msg.type === 'ready') {
        clearTimeout(timer)
        worker.onmessage = null
        worker.onerror = null
        resolve({ worker, delegate: msg.delegate })
      } else if (msg.type === 'error' && msg.fatal) {
        fail(new Error(msg.message))
      }
    }
    const lite = absolute(MODEL_LITE)
    const attempts: TrackerAttempt[] = trackerAttempts().map((a) => ({ ...a, model: absolute(a.model), lite }))
    const init: WorkerRequest = {
      type: 'init',
      wasm: absoluteWasm(),
      attempts,
      options: { detection: MIN_DETECTION_CONFIDENCE, presence: MIN_PRESENCE_CONFIDENCE, tracking: MIN_TRACKING_CONFIDENCE },
    }
    worker.postMessage(init)
  })
}

/** Unpacks a worker landmark array into mirrored Joints, reusing out's objects when it has them. */
export function unpackJoints(packed: Float32Array, mirror: 'image' | 'world', out: Joint[] = []): Joint[] {
  for (let i = 0; i < LANDMARKS; i++) {
    const o = i * STRIDE
    const x = packed[o]
    const j = out[i] ?? (out[i] = { x: 0, y: 0, z: 0, visibility: 0 })
    j.x = mirror === 'image' ? 1 - x : -x
    j.y = packed[o + 1]
    j.z = packed[o + 2]
    j.visibility = packed[o + 3]
  }
  out.length = LANDMARKS
  return out
}

async function buildLandmarker(): Promise<Tracker> {
  try {
    const { PoseLandmarker } = await loadVision()
    const fileset = WASM.classic
    for (const { delegate, model } of trackerAttempts()) {
      try {
        const landmarker = await PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: model, delegate },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: MIN_DETECTION_CONFIDENCE,
          minPosePresenceConfidence: MIN_PRESENCE_CONFIDENCE,
          minTrackingConfidence: MIN_TRACKING_CONFIDENCE,
        })
        return { landmarker, delegate }
      } catch (err) {
        console.warn(`Pose landmarker failed on ${delegate} with ${model}`, err)
      }
    }
  } catch (err) {
    console.warn('MediaPipe runtime failed to load', err)
  }
  throw new StartupError('tracker-failed', 'Pose tracker could not start (offline or download blocked?)')
}

/** buildLandmarker with a timeout. A landmarker that arrives after the timeout is closed. */
function createLandmarker(): Promise<Tracker> {
  return new Promise((resolve, reject) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      reject(new StartupError('tracker-failed', 'Pose tracker took too long to load'))
    }, TRACKER_TIMEOUT_MS)
    buildLandmarker().then(
      (tracker) => {
        clearTimeout(timer)
        if (timedOut) tracker.landmarker.close()
        else resolve(tracker)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}

const toImage = (p: NormalizedLandmark): Joint => ({ x: 1 - p.x, y: p.y, z: p.z, visibility: p.visibility ?? 0 })
const toWorld = (p: RawLandmark): Joint => ({ x: -p.x, y: p.y, z: p.z, visibility: p.visibility ?? 0 })

async function attachStream(video: HTMLVideoElement, stream: MediaStream): Promise<void> {
  video.muted = true
  video.playsInline = true
  video.srcObject = stream
  if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No video metadata')), METADATA_TIMEOUT_MS)
      const settle = (err?: Error): void => {
        clearTimeout(timer)
        if (err) reject(err)
        else resolve()
      }
      video.addEventListener('loadedmetadata', () => settle(), { once: true })
      video.addEventListener('error', () => settle(new Error('Video element error')), { once: true })
      stream.getVideoTracks()[0]?.addEventListener('ended', () => settle(new Error('Camera track ended')), {
        once: true,
      })
    })
  }
  await video.play()
  if (!stream.getVideoTracks().some((t) => t.readyState === 'live')) throw new Error('Camera track ended')
}

/** Where tracking runs once started: a worker, or a landmarker on this thread. */
type Engine =
  | { kind: 'worker'; worker: Worker; delegate: Delegate }
  | { kind: 'main'; landmarker: PoseLandmarker; delegate: Delegate }
  /** Between a worker failure and its main-thread replacement: frames are skipped. */
  | { kind: 'pending'; delegate: Delegate }

/** Worker first, main thread as the fallback. Rejects only with StartupError. */
async function createEngine(): Promise<Engine> {
  if (workerAllowed()) {
    try {
      const w = await startWorker()
      return { kind: 'worker', worker: w.worker, delegate: w.delegate }
    } catch (err) {
      console.warn('Pose worker unavailable, tracking on the main thread', err)
    }
  }
  const t = await createLandmarker()
  return { kind: 'main', landmarker: t.landmarker, delegate: t.delegate }
}

function closeEngine(e: Engine): void {
  if (e.kind === 'worker') {
    e.worker.onmessage = null
    e.worker.onerror = null
    try {
      e.worker.postMessage({ type: 'dispose' } satisfies WorkerRequest)
    } catch {
      // already gone
    }
    e.worker.terminate()
  } else if (e.kind === 'main') {
    e.landmarker.close()
  }
}

/** Width of the frames sent to the worker, px. */
const INFER_WIDTH = 480
/** A worker frame that never comes back (crash, hang) must not stall tracking forever, ms. */
const WORKER_FRAME_TIMEOUT_MS = 2000

async function launch(video: HTMLVideoElement, onStop: () => void): Promise<PosePipeline> {
  // Load the tracker while the camera permission prompt is open; fail fast on either error.
  const engineP = createEngine()
  let stream: MediaStream
  try {
    stream = await openCamera()
  } catch (err) {
    engineP.then(closeEngine, () => {})
    throw err
  }

  let engine: Engine
  try {
    engine = await engineP
  } catch (err) {
    stopStream(stream)
    throw err
  }

  try {
    await attachStream(video, stream)
  } catch (err) {
    stopStream(stream)
    video.srcObject = null
    closeEngine(engine)
    throw new StartupError('camera-other', `Video playback failed: ${String(err)}`)
  }

  const subscribers = new Set<(frame: PoseFrame | null) => void>()
  let running = true
  let lastVideoTime = -1
  let inferenceMs = 0
  let warnedFrame = false
  let warnedSubscriber = false
  /** Worker path: a frame is in flight since this time, null when idle. */
  let busySince: number | null = null

  const publish = (frame: PoseFrame | null): void => {
    for (const cb of subscribers) {
      try {
        cb(frame)
      } catch (err) {
        if (!warnedSubscriber) console.warn('Pose subscriber failed (logged once)', err)
        warnedSubscriber = true
      }
    }
  }

  const noteInference = (ms: number): void => {
    inferenceMs = inferenceMs === 0 ? ms : inferenceMs + INFERENCE_EMA * (ms - inferenceMs)
  }

  /** Frames are stamped with the camera's capture time, so wrist speeds do not jitter with load. */
  const clock = createFrameClock()

  const detectOnMain = (landmarker: PoseLandmarker, t: number): void => {
    const now = performance.now()
    try {
      const result = landmarker.detectForVideo(video, t)
      noteInference(performance.now() - now)
      const image = result.landmarks[0]
      const world = result.worldLandmarks[0]
      publish(image && world ? { t, image: image.map(toImage), world: world.map(toWorld) } : null)
    } catch (err) {
      if (!warnedFrame) console.warn('Pose frame failed (logged once)', err)
      warnedFrame = true
    }
  }

  /** The worker died after starting: carry on with a main-thread landmarker rather than end the game. */
  const fallBackToMain = (why: string): void => {
    if (!running || engine.kind !== 'worker') return
    console.warn(`Pose worker failed (${why}); tracking on the main thread`)
    closeEngine(engine)
    busySince = null
    createLandmarker().then(
      (t) => {
        if (!running) {
          t.landmarker.close()
          return
        }
        engine = { kind: 'main', landmarker: t.landmarker, delegate: t.delegate }
      },
      () => lost('Pose tracker stopped'),
    )
    // Until the landmarker arrives, ticks skip frames.
    engine = { kind: 'pending', delegate: engine.delegate }
  }

  const wireWorker = (w: Worker): void => {
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (!running) return
      const msg = e.data
      if (msg.type === 'result') {
        busySince = null
        noteInference(msg.inferenceMs)
        publish(
          msg.image && msg.world
            ? { t: msg.t, image: unpackJoints(msg.image, 'image'), world: unpackJoints(msg.world, 'world') }
            : null,
        )
      } else if (msg.type === 'ready') {
        if (engine.kind === 'worker') engine.delegate = msg.delegate
      } else if (msg.type === 'error') {
        busySince = null
        if (msg.fatal) fallBackToMain(msg.message)
        else if (!warnedFrame) {
          console.warn('Pose frame failed (logged once)', msg.message)
          warnedFrame = true
        }
      }
    }
    w.onerror = (e) => fallBackToMain(e.message || 'worker error')
  }
  if (engine.kind === 'worker') wireWorker(engine.worker)

  const sendToWorker = (w: Worker, t: number): void => {
    const now = performance.now()
    if (busySince !== null) {
      // Skip frames while the worker is busy; recover if one never comes back.
      if (now - busySince < WORKER_FRAME_TIMEOUT_MS) return
      busySince = null
    }
    busySince = now
    // Inference size: the model works on 256x256 internally, so 480x360 loses nothing and halves conversion.
    const vw = video.videoWidth
    const vh = video.videoHeight
    const scale = vw > 0 && vh > 0 ? Math.min(1, INFER_WIDTH / vw) : 1
    const resize: ImageBitmapOptions =
      scale < 1 ? { resizeWidth: Math.round(vw * scale), resizeHeight: Math.round(vh * scale), resizeQuality: 'low' } : {}
    createImageBitmap(video, resize).then(
      (bitmap) => {
        if (!running || engine.kind !== 'worker' || engine.worker !== w) {
          bitmap.close()
          return
        }
        const msg: WorkerRequest = { type: 'frame', bitmap, t, captureT: t }
        w.postMessage(msg, [bitmap])
      },
      () => {
        busySince = null
      },
    )
  }

  // Schedule the next tick before processing, so nothing thrown below can stop the loop.
  const useVfc = typeof video.requestVideoFrameCallback === 'function'
  const schedule = (): void => {
    if (useVfc) video.requestVideoFrameCallback(tick)
    else requestAnimationFrame(tick)
  }
  const tick = (now: number, meta?: FrameMeta): void => {
    if (!running) return
    schedule()
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
    if (!useVfc) {
      if (video.currentTime === lastVideoTime) return
      lastVideoTime = video.currentTime
    }
    if (engine.kind === 'worker') sendToWorker(engine.worker, clock.stamp(now, meta))
    else if (engine.kind === 'main') detectOnMain(engine.landmarker, clock.stamp(now, meta))
  }
  schedule()

  const teardown = (): void => {
    running = false
    subscribers.clear()
    for (const track of stream.getTracks()) track.removeEventListener('ended', onTrackEnded)
    video.removeEventListener('emptied', onEmptied)
    stopStream(stream)
    if (video.srcObject === stream) video.srcObject = null
    closeEngine(engine)
    onStop()
  }

  // Camera loss: release everything, then tell the games so they can show an error instead of waiting.
  const lost = (reason: string): void => {
    if (!running) return
    console.warn(`Pose pipeline ended: ${reason}`)
    teardown()
    for (const cb of [...endedListeners]) {
      try {
        cb(reason)
      } catch (err) {
        console.warn('Pipeline ended listener failed', err)
      }
    }
  }
  const onTrackEnded = (): void => lost('Camera disconnected')
  const onEmptied = (): void => {
    if (video.srcObject !== stream) lost('Camera feed removed')
  }
  for (const track of stream.getTracks()) track.addEventListener('ended', onTrackEnded)
  video.addEventListener('emptied', onEmptied)

  return {
    video,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    get delegate() {
      return engine.delegate
    },
    get mode() {
      return engine.kind === 'worker' ? 'worker' : 'main'
    },
    get inferenceMs() {
      return inferenceMs
    },
    subscribe(cb) {
      subscribers.add(cb)
      return () => {
        subscribers.delete(cb)
      }
    },
    stop() {
      if (running) teardown()
    },
  }
}

/** The running (or starting) pipeline, shared by every caller until stop(). */
let current: Promise<PosePipeline> | null = null

/**
 * Starts the webcam and pose tracker once. Repeated or concurrent calls get the same pipeline
 * (the first call's video element is used). Rejects only with StartupError.
 */
export function startPosePipeline(video: HTMLVideoElement): Promise<PosePipeline> {
  if (current) return current
  // Both callbacks run only after this assignment (stop needs a resolved pipeline, catch is async).
  const starting: Promise<PosePipeline> = launch(video, () => {
    if (current === starting) current = null
  }).catch((err: unknown) => {
    if (current === starting) current = null
    throw err instanceof StartupError ? err : new StartupError('camera-other', String(err))
  })
  current = starting
  return starting
}
