// TEMPORARY dev stand-in for the shared PosePipeline (src/pose, being built by another team).
// Used only by the standalone goalkeeper dev page (dev.ts / goalkeeper.html).
// DELETE THIS FILE once the shared pipeline lands and main.ts drives the goalkeeper sport.
// It is deliberately self-contained: it only shares `import type` contracts with src/pose.
//
// Webcam -> MediaPipe PoseLandmarker (VIDEO mode) -> mirror + aspect-correct -> 2 s hold-stance
// calibration gate (research doc "Shared Camera Calibration") -> BodyFrame per src/pose/types.ts,
// 1-euro filtered with the goalkeeper tuning (minCutoff 1.2 Hz, beta 0.12).

import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import type { Landmark, NormalizedLandmark } from '@mediapipe/tasks-vision'
import type { BodyFrame, Calibration, CalibrationStatus, Joint } from '../../pose/types.ts'
import { OneEuroFilter, OneEuroVec3 } from './filter.ts'

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm'
const MODEL_URL = '/models/pose_landmarker_lite.task'

const L_SHOULDER = 11
const R_SHOULDER = 12
const NOSE = 0
const VIS_MIN = 0.5
const CALIB_FRAMES = 15
const CALIB_HOLD_MS = 2000
const DEFAULT_SHOULDER_M = 0.4

/** Joints filtered for the goalkeeper: nose, shoulders, elbows, wrists, index tips. */
const FILTERED = [0, 11, 12, 13, 14, 15, 16, 19, 20] as const
const MIN_CUTOFF = 1.2
const BETA = 0.12
const D_CUTOFF = 1.0

export interface DevCamera {
  stop(): void
  /** Calibration result once the hold-stance gate has passed, else null. */
  calibration(): Calibration | null
}

function friendlyCameraError(err: unknown): Error {
  const name = err instanceof DOMException || err instanceof Error ? err.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return new Error('Camera access was blocked. Allow the camera in your browser settings and retry, or play with the mouse.')
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return new Error('No camera was found. Plug one in and retry, or play with the mouse.')
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new Error('The camera is in use by another app. Close it and retry, or play with the mouse.')
    default:
      return new Error(
        `The camera could not start${err instanceof Error && err.message ? ` (${err.message})` : ''}. Retry, or play with the mouse.`,
      )
  }
}

async function openCamera(video: HTMLVideoElement): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser cannot use a camera here (it needs HTTPS or localhost). Play with the mouse instead.')
  }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
    })
  } catch (err) {
    throw friendlyCameraError(err)
  }
  video.srcObject = stream
  video.muted = true
  video.playsInline = true
  try {
    await video.play()
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop())
    throw friendlyCameraError(err)
  }
  if (video.readyState < HTMLMediaElement.HAVE_METADATA || video.videoWidth === 0) {
    await new Promise<void>((resolve) => video.addEventListener('loadedmetadata', () => resolve(), { once: true }))
  }
  return stream
}

async function createLandmarker(): Promise<PoseLandmarker> {
  let fileset
  try {
    fileset = await FilesetResolver.forVisionTasks(WASM_URL)
  } catch {
    throw new Error('The pose tracker could not load (network?). Retry, or play with the mouse.')
  }
  const make = (delegate: 'GPU' | 'CPU') =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
    })
  try {
    return await make('GPU')
  } catch (gpuErr) {
    console.warn('[dev-camera] GPU delegate failed, falling back to CPU', gpuErr)
    try {
      return await make('CPU')
    } catch {
      throw new Error('The pose tracker could not start on this device. Play with the mouse instead.')
    }
  }
}

export async function startDevCamera(
  video: HTMLVideoElement,
  onBody: (body: BodyFrame | null) => void,
  onCalibration: (progress: number, status: CalibrationStatus) => void,
): Promise<DevCamera> {
  const stream = await openCamera(video)
  let landmarker: PoseLandmarker
  try {
    landmarker = await createLandmarker()
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop())
    video.srcObject = null
    throw err
  }

  let running = true
  let raf = 0
  let lastVideoTime = -1
  let lastTs = 0
  let calibration: Calibration | null = null

  // Calibration accumulators (aspect-corrected mirrored image units).
  let holdStart = 0
  let n = 0
  let sumS = 0
  let sumCx = 0
  let sumCy = 0
  let sumNx = 0
  let sumNy = 0
  let sumSWorld = 0
  let nWorld = 0

  const bodyFilters = new Map<number, { x: OneEuroFilter; y: OneEuroFilter }>()
  const worldFilters = new Map<number, OneEuroVec3>()
  for (const j of FILTERED) {
    bodyFilters.set(j, { x: new OneEuroFilter(MIN_CUTOFF, BETA, D_CUTOFF), y: new OneEuroFilter(MIN_CUTOFF, BETA, D_CUTOFF) })
    worldFilters.set(j, new OneEuroVec3(MIN_CUTOFF, BETA, D_CUTOFF))
  }
  const resetFilters = (): void => {
    for (const f of bodyFilters.values()) {
      f.x.reset()
      f.y.reset()
    }
    for (const f of worldFilters.values()) f.reset()
  }

  const resetCalib = (): void => {
    holdStart = 0
    n = sumS = sumCx = sumCy = sumNx = sumNy = sumSWorld = nWorld = 0
  }

  const report = (progress: number, status: CalibrationStatus): void => {
    onCalibration(progress, status)
  }

  const vis = (l: { visibility?: number } | undefined): number => l?.visibility ?? 0

  function handleCalibration(t: number, img: NormalizedLandmark[] | undefined, world: Landmark[] | undefined, aspect: number): void {
    if (!img || img.length < 33) {
      resetCalib()
      report(0, 'no-pose')
      return
    }
    const ls = img[L_SHOULDER]
    const rs = img[R_SHOULDER]
    if (vis(ls) <= VIS_MIN || vis(rs) <= VIS_MIN) {
      resetCalib()
      report(0, 'shoulders-hidden')
      return
    }
    const lx = (1 - ls.x) * aspect
    const rx = (1 - rs.x) * aspect
    const s = Math.hypot(lx - rx, ls.y - rs.y)
    if (!(s > 1e-4)) {
      resetCalib()
      report(0, 'shoulders-hidden')
      return
    }
    if (n === 0) holdStart = t
    n++
    sumS += s
    sumCx += (lx + rx) / 2
    sumCy += (ls.y + rs.y) / 2
    const nose = img[NOSE]
    sumNx += (1 - nose.x) * aspect
    sumNy += nose.y
    const wl = world?.[L_SHOULDER]
    const wr = world?.[R_SHOULDER]
    if (wl && wr) {
      const sw = Math.hypot(wl.x - wr.x, wl.y - wr.y, wl.z - wr.z)
      if (sw > 0.05 && sw < 1.5) {
        sumSWorld += sw
        nWorld++
      }
    }
    const progress = Math.min(n / CALIB_FRAMES, (t - holdStart) / CALIB_HOLD_MS, 1)
    if (progress < 1) {
      report(progress, 'holding')
      return
    }
    calibration = {
      aspect,
      shoulderWidth: sumS / n,
      shoulderWidthWorld: nWorld > 0 ? sumSWorld / nWorld : DEFAULT_SHOULDER_M,
      torsoCenter: { x: sumCx / n, y: sumCy / n },
      neutralNose: { x: sumNx / n, y: sumNy / n },
    }
    resetFilters()
    report(1, 'done')
  }

  function buildBody(t: number, img: NormalizedLandmark[], world: Landmark[] | undefined, aspect: number, cal: Calibration): BodyFrame {
    const ts = t / 1000
    const S = cal.shoulderWidth
    const C = cal.torsoCenter
    const body: Joint[] = new Array(33)
    const worldOut: Joint[] = new Array(33)
    for (let i = 0; i < 33; i++) {
      const l = img[i]
      let x = l ? ((1 - l.x) * aspect - C.x) / S : 0
      let y = l ? (l.y - C.y) / S : 0
      const f = bodyFilters.get(i)
      if (f && l) {
        x = f.x.filter(x, ts)
        y = f.y.filter(y, ts)
      }
      body[i] = { x, y, z: 0, visibility: vis(l) }

      const w = world?.[i]
      if (w) {
        let p = { x: -w.x, y: w.y, z: w.z }
        const wf = worldFilters.get(i)
        if (wf) p = wf.filter(p, ts)
        worldOut[i] = { x: p.x, y: p.y, z: p.z, visibility: vis(w) }
      } else {
        worldOut[i] = { x: 0, y: 0, z: 0, visibility: 0 }
      }
    }
    const ls = img[L_SHOULDER]
    const rs = img[R_SHOULDER]
    const live = Math.hypot((rs.x - ls.x) * aspect, rs.y - ls.y)
    return {
      t,
      body,
      world: worldOut,
      neutralNose: { x: (cal.neutralNose.x - C.x) / S, y: (cal.neutralNose.y - C.y) / S },
      scale: live > 1e-4 ? live / S : 1,
      calibration: cal,
    }
  }

  const tick = (): void => {
    if (!running) return
    raf = requestAnimationFrame(tick)
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) return
    if (video.currentTime === lastVideoTime) return
    lastVideoTime = video.currentTime
    let t = performance.now()
    if (t <= lastTs) t = lastTs + 0.001
    lastTs = t
    const aspect = video.videoWidth / video.videoHeight
    let result
    try {
      result = landmarker.detectForVideo(video, t)
    } catch (err) {
      console.warn('[dev-camera] detectForVideo failed', err)
      return
    }
    const img = result.landmarks[0]
    const world = result.worldLandmarks[0]
    if (!calibration) {
      handleCalibration(t, img, world, aspect)
      return
    }
    if (!img || img.length < 33) {
      resetFilters()
      onBody(null)
      return
    }
    onBody(buildBody(t, img, world, aspect, calibration))
  }

  report(0, 'no-pose')
  raf = requestAnimationFrame(tick)

  return {
    stop() {
      if (!running) return
      running = false
      cancelAnimationFrame(raf)
      stream.getTracks().forEach((tr) => tr.stop())
      video.srcObject = null
      try {
        landmarker.close()
      } catch {
        /* already closed */
      }
    },
    calibration: () => calibration,
  }
}
