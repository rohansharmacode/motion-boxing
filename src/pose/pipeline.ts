// Singleton webcam + MediaPipe PoseLandmarker loop (research doc section 4, Shared Pose Pipeline).
// Runs on the main thread for now. One detection per new camera frame, x mirrored once here.
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import type { Landmark as RawLandmark, NormalizedLandmark } from '@mediapipe/tasks-vision'
import { StartupError } from './types.ts'
import type { Joint, PoseFrame, StartupErrorKind } from './types.ts'

/** WASM runtime. The version in this URL must match @mediapipe/tasks-vision in package.json. */
const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm'
const MODEL_PATH = import.meta.env.BASE_URL + 'models/pose_landmarker_lite.task'
/** Weight of the newest sample in the inference time average. */
const INFERENCE_EMA = 0.1

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

async function createLandmarker(): Promise<{ landmarker: PoseLandmarker; delegate: Delegate }> {
  try {
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
  throw new StartupError('tracker-failed', 'Pose tracker could not start')
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
      video.addEventListener('loadedmetadata', () => resolve(), { once: true })
      video.addEventListener('error', () => reject(new Error('Video element error')), { once: true })
    })
  }
  await video.play()
}

async function launch(video: HTMLVideoElement, onStop: () => void): Promise<PosePipeline> {
  const [camera, tracker] = await Promise.allSettled([openCamera(), createLandmarker()])
  if (camera.status === 'rejected' || tracker.status === 'rejected') {
    if (camera.status === 'fulfilled') stopStream(camera.value)
    if (tracker.status === 'fulfilled') tracker.value.landmarker.close()
    const reason: unknown = camera.status === 'rejected' ? camera.reason : tracker.status === 'rejected' ? tracker.reason : null
    throw reason instanceof StartupError ? reason : new StartupError('camera-other', String(reason))
  }
  const stream = camera.value
  const { landmarker, delegate } = tracker.value

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

  const pipeline: PosePipeline = {
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
      if (!running) return
      running = false
      subscribers.clear()
      stopStream(stream)
      video.srcObject = null
      landmarker.close()
      onStop()
    },
  }
  return pipeline
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
