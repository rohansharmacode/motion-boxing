import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import type { Landmark as RawLandmark, NormalizedLandmark } from '@mediapipe/tasks-vision'
import { StartupError } from './types.ts'
import type { Landmark, PoseFrame, StartupErrorKind } from './types.ts'

/** WASM runtime. The version in this URL must match @mediapipe/tasks-vision in package.json. */
const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm'
const MODEL_PATH = import.meta.env.BASE_URL + 'models/pose_landmarker_lite.task'

export interface PoseTracker {
  readonly videoWidth: number
  readonly videoHeight: number
  readonly delegate: 'GPU' | 'CPU'
  stop(): void
}

type Delegate = PoseTracker['delegate']

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
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } },
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

const toImage = (p: NormalizedLandmark): Landmark => ({ x: 1 - p.x, y: p.y, z: p.z, visibility: p.visibility ?? 0 })
const toWorld = (p: RawLandmark): Landmark => ({ x: -p.x, y: p.y, z: p.z, visibility: p.visibility ?? 0 })

async function attachStream(video: HTMLVideoElement, stream: MediaStream): Promise<void> {
  video.srcObject = stream
  if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
    await new Promise<void>((resolve, reject) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true })
      video.addEventListener('error', () => reject(new Error('Video element error')), { once: true })
    })
  }
  await video.play()
}

export async function startPose(
  video: HTMLVideoElement,
  onFrame: (frame: PoseFrame | null) => void,
): Promise<PoseTracker> {
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
    landmarker.close()
    throw new StartupError('camera-other', `Video playback failed: ${String(err)}`)
  }

  let running = true
  let lastT = -Infinity
  let lastVideoTime = -1
  let warned = false

  const process = (): void => {
    const now = performance.now()
    const t = now > lastT ? now : lastT + 1
    lastT = t
    try {
      const result = landmarker.detectForVideo(video, t)
      const image = result.landmarks[0]
      const world = result.worldLandmarks[0]
      onFrame(image && world ? { t, image: image.map(toImage), world: world.map(toWorld) } : null)
    } catch (err) {
      if (!warned) console.warn('Pose frame failed (logged once)', err)
      warned = true
    }
  }

  // Schedule the next tick before processing, so nothing thrown here can stop the loop.
  const useVfc = typeof video.requestVideoFrameCallback === 'function'
  const schedule = (): void => {
    if (useVfc) video.requestVideoFrameCallback(tick)
    else requestAnimationFrame(tick)
  }
  const tick = (): void => {
    if (!running) return
    schedule()
    if (useVfc) return process()
    if (video.currentTime === lastVideoTime) return
    lastVideoTime = video.currentTime
    process()
  }
  schedule()

  return {
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    delegate,
    stop() {
      if (!running) return
      running = false
      stopStream(stream)
      video.srcObject = null
      landmarker.close()
    },
  }
}
