// Pose tracking worker: runs MediaPipe PoseLandmarker off the main thread so rendering never waits on
// inference. The main thread transfers one ImageBitmap per camera frame (zero copy) and gets packed
// landmarks back as transferred Float32Arrays. Protocol types live in workerProtocol.ts.
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import type { NormalizedLandmark, Landmark } from '@mediapipe/tasks-vision'
import { LANDMARKS, STRIDE } from './workerProtocol.ts'
import type { TrackerAttempt, WorkerRequest, WorkerResponse } from './workerProtocol.ts'

interface WorkerScope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  close(): void
}
const scope = self as unknown as WorkerScope

let landmarker: PoseLandmarker | null = null
let current: TrackerAttempt | null = null
let wasmBase = ''
let options: { detection: number; presence: number; tracking: number } = { detection: 0.5, presence: 0.4, tracking: 0.4 }
let lastT = -Infinity

/** Vite serves workers as ES modules in dev and bundles them as classic scripts in build: MediaPipe needs to know which. */
function isModuleWorker(): boolean {
  const g = globalThis as unknown as { importScripts?: (...urls: string[]) => void }
  if (typeof g.importScripts !== 'function') return true
  try {
    g.importScripts()
    return false
  } catch {
    return true
  }
}

async function create(attempt: TrackerAttempt): Promise<PoseLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(wasmBase, isModuleWorker())
  return PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: attempt.model, delegate: attempt.delegate },
    // GPU in a worker needs its own canvas; MediaPipe cannot reach the DOM from here.
    canvas: attempt.delegate === 'GPU' ? new OffscreenCanvas(1, 1) : undefined,
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: options.detection,
    minPosePresenceConfidence: options.presence,
    minTrackingConfidence: options.tracking,
  })
}

async function init(attempts: TrackerAttempt[]): Promise<void> {
  const errors: string[] = []
  for (const attempt of attempts) {
    try {
      landmarker = await create(attempt)
      current = attempt
      scope.postMessage({ type: 'ready', delegate: attempt.delegate, model: attempt.model })
      return
    } catch (err) {
      errors.push(`${attempt.delegate}: ${String(err)}`)
    }
  }
  scope.postMessage({ type: 'error', fatal: true, message: `Pose tracker failed to start (${errors.join('; ')})` })
}

function pack(points: Array<NormalizedLandmark | Landmark> | undefined): Float32Array | null {
  if (!points || points.length < LANDMARKS) return null
  const out = new Float32Array(LANDMARKS * STRIDE)
  for (let i = 0; i < LANDMARKS; i++) {
    const p = points[i]
    out[i * STRIDE] = p.x
    out[i * STRIDE + 1] = p.y
    out[i * STRIDE + 2] = p.z
    out[i * STRIDE + 3] = p.visibility ?? 0
  }
  return out
}

async function frame(bitmap: ImageBitmap, t: number, captureT: number): Promise<void> {
  try {
    if (!landmarker || !current) throw new Error('Tracker not ready')
    // MediaPipe needs strictly increasing timestamps.
    const ts = t > lastT ? t : lastT + 1
    lastT = ts
    const start = performance.now()
    let result
    try {
      result = landmarker.detectForVideo(bitmap, ts)
    } catch (err) {
      if (current.delegate === 'CPU') throw err
      // A GPU context loss mid-round: drop to the CPU lite model and keep going.
      landmarker.close()
      const cpu: TrackerAttempt = { delegate: 'CPU', model: current.lite, lite: current.lite }
      landmarker = await create(cpu)
      current = cpu
      scope.postMessage({ type: 'ready', delegate: 'CPU', model: cpu.model })
      result = landmarker.detectForVideo(bitmap, ts)
    }
    const inferenceMs = performance.now() - start
    const image = pack(result.landmarks[0])
    const world = pack(result.worldLandmarks[0])
    const transfer: Transferable[] = []
    if (image) transfer.push(image.buffer)
    if (world) transfer.push(world.buffer)
    scope.postMessage({ type: 'result', t, captureT, inferenceMs, image: image && world ? image : null, world: image && world ? world : null }, transfer)
  } catch (err) {
    scope.postMessage({ type: 'error', fatal: false, message: String(err), t })
  } finally {
    bitmap.close()
  }
}

scope.onmessage = (event) => {
  const msg = event.data
  if (msg.type === 'init') {
    wasmBase = msg.wasmBase
    options = msg.options
    void init(msg.attempts)
  } else if (msg.type === 'frame') {
    void frame(msg.bitmap, msg.t, msg.captureT)
  } else if (msg.type === 'dispose') {
    landmarker?.close()
    landmarker = null
    scope.close()
  }
}
