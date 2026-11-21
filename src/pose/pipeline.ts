// Singleton webcam + MediaPipe PoseLandmarker loop (research doc section 4, Shared Pose Pipeline).
// Runs on the main thread for now. One detection per new camera frame, x mirrored once here.
// MediaPipe is imported lazily so the library stays out of the initial bundle.
import type { Landmark as RawLandmark, NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision'
import { StartupError } from './types.ts'
import type { Joint, PoseFrame, StartupErrorKind } from './types.ts'

/** WASM runtime. The version in this URL must match @mediapipe/tasks-vision in package.json. */
const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm'
const MODEL_PATH = import.meta.env.BASE_URL + 'models/pose_landmarker_lite.task'
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
  const urls = [MODEL_PATH, `${WASM_BASE}/vision_wasm_internal.js`, `${WASM_BASE}/vision_wasm_internal.wasm`]
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
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    })
  } catch (err) {
    throw new StartupError(cameraErrorKind(err), `Camera failed: ${String(err)}`)
  }
}

async function buildLandmarker(): Promise<Tracker> {
  try {
    const { FilesetResolver, PoseLandmarker } = await loadVision()
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE)
    for (const delegate of ['GPU', 'CPU'] as const) {
      try {
        const landmarker = await PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_PATH, delegate },
          runningMode: 'VIDEO',
          numPoses: 1,
        })
        return { landmarker, delegate }
      } catch (err) {
        console.warn(`Pose landmarker failed on ${delegate}`, err)
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

async function launch(video: HTMLVideoElement, onStop: () => void): Promise<PosePipeline> {
  // Load the tracker while the camera permission prompt is open; fail fast on either error.
  const trackerP = createLandmarker()
  let stream: MediaStream
  try {
    stream = await openCamera()
  } catch (err) {
    trackerP.then((t) => t.landmarker.close(), () => {})
    throw err
  }

  let tracker: Tracker
  try {
    tracker = await trackerP
  } catch (err) {
    stopStream(stream)
    throw err
  }
  const { landmarker, delegate } = tracker

  try {
    await attachStream(video, stream)
  } catch (err) {
    stopStream(stream)
    video.srcObject = null
    landmarker.close()
    throw new StartupError('camera-other', `Video playback failed: ${String(err)}`)
  }

  const subscribers = new Set<(frame: PoseFrame | null) => void>()
  let running = true
  let lastT = -Infinity
  let lastVideoTime = -1
  let inferenceMs = 0
  let warnedFrame = false
  let warnedSubscriber = false

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

  const detectFrame = (): void => {
    const now = performance.now()
    const t = now > lastT ? now : lastT + 1
    lastT = t
    try {
      const result = landmarker.detectForVideo(video, t)
      const ms = performance.now() - now
      inferenceMs = inferenceMs === 0 ? ms : inferenceMs + INFERENCE_EMA * (ms - inferenceMs)
      const image = result.landmarks[0]
      const world = result.worldLandmarks[0]
      publish(image && world ? { t, image: image.map(toImage), world: world.map(toWorld) } : null)
    } catch (err) {
      if (!warnedFrame) console.warn('Pose frame failed (logged once)', err)
      warnedFrame = true
    }
  }

  // Schedule the next tick before processing, so nothing thrown below can stop the loop.
  const useVfc = typeof video.requestVideoFrameCallback === 'function'
  const schedule = (): void => {
    if (useVfc) video.requestVideoFrameCallback(tick)
    else requestAnimationFrame(tick)
  }
  const tick = (): void => {
    if (!running) return
    schedule()
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
    if (!useVfc) {
      if (video.currentTime === lastVideoTime) return
      lastVideoTime = video.currentTime
    }
    detectFrame()
  }
  schedule()

  const teardown = (): void => {
    running = false
    subscribers.clear()
    for (const track of stream.getTracks()) track.removeEventListener('ended', onTrackEnded)
    video.removeEventListener('emptied', onEmptied)
    stopStream(stream)
    if (video.srcObject === stream) video.srcObject = null
    landmarker.close()
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
    delegate,
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
